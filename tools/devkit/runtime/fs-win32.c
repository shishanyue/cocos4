#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* A bounded parent-only RPC service. Every lease retains its complete local
 * path chain with no FILE_SHARE_DELETE. Reparse points are rejected before a
 * descendant is opened. File readers permit writes and verify their own content
 * stamps; executable leases additionally withhold FILE_SHARE_WRITE. */
#define PATH_CAP 4101
#define LINE_CAP 33000
#define PIN_CAP 130
#define LEASE_CAP 2048
#define FLAG_DIRECTORY 1U
#define FLAG_PRIVATE 2U
#define FLAG_TRUSTED 4U
#define FLAG_IMMUTABLE 8U

typedef struct { HANDLE handle; BY_HANDLE_FILE_INFORMATION identity; wchar_t *path; } Pin;
typedef struct { uint64_t token; unsigned flags; size_t count; Pin *pins; } Lease;
static Lease leases[LEASE_CAP];
static uint64_t next_token = 1;
static PSID current_sid, system_sid, administrators_sid, installer_sid, creator_sid;
static const char *error_kind = "io";
static DWORD error_code = ERROR_INVALID_DATA;

static int failure(const char *kind, DWORD code) { error_kind = kind; error_code = code; return 0; }
static int allowed_sid(PSID sid, int system_ancestor) {
    return EqualSid(sid, current_sid) || EqualSid(sid, system_sid) || EqualSid(sid, administrators_sid)
        || (system_ancestor && EqualSid(sid, installer_sid));
}
static int init_sids(void) {
    HANDLE token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    TOKEN_USER *user = (TOKEN_USER *) malloc(size);
    int ok = user && GetTokenInformation(token, TokenUser, user, size, &size);
    if (ok) { DWORD length = GetLengthSid(user->User.Sid); current_sid = malloc(length); ok = current_sid && CopySid(length, current_sid, user->User.Sid); }
    free(user); CloseHandle(token);
    return ok && ConvertStringSidToSidW(L"S-1-5-18", &system_sid)
        && ConvertStringSidToSidW(L"S-1-5-32-544", &administrators_sid)
        && ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer_sid)
        && ConvertStringSidToSidW(L"S-1-3-0", &creator_sid);
}
static int valid_component(const wchar_t *text, size_t length) {
    if (!length || length > 255 || text[length - 1] == L'.' || text[length - 1] == L' ') return 0;
    size_t stem = length;
    for (size_t i = 0; i < length; ++i) {
        wchar_t c = text[i];
        if (c < 32 || c == 127 || wcschr(L"/\\:<>\"|?*", c)) return 0;
        if (c == L'.' && stem == length) stem = i;
    }
    while (stem && text[stem - 1] == L' ') --stem;
    if ((stem == 3 && (!_wcsnicmp(text, L"con", 3) || !_wcsnicmp(text, L"prn", 3) || !_wcsnicmp(text, L"aux", 3) || !_wcsnicmp(text, L"nul", 3)))
        || (stem == 6 && (!_wcsnicmp(text, L"conin$", 6) || !_wcsnicmp(text, L"clock$", 6)))
        || (stem == 7 && !_wcsnicmp(text, L"conout$", 7))) return 0;
    if (stem == 4 && (!_wcsnicmp(text, L"com", 3) || !_wcsnicmp(text, L"lpt", 3))) {
        wchar_t c = text[3];
        if ((c >= L'1' && c <= L'9') || c == 0x00b9 || c == 0x00b2 || c == 0x00b3) return 0;
    }
    return 1;
}
static int valid_path(const wchar_t *text) {
    size_t length = wcslen(text);
    if (length < 3 || length > 4096 || !((text[0] >= L'A' && text[0] <= L'Z') || (text[0] >= L'a' && text[0] <= L'z'))
        || text[1] != L':' || text[2] != L'\\' || (length > 3 && text[length - 1] == L'\\')) return 0;
    size_t start = 3, count = 0;
    for (size_t i = 3; i <= length; ++i) if (!text[i] || text[i] == L'\\') {
        if (i == 3 && length == 3) break;
        if (!valid_component(text + start, i - start) || ++count > 128) return 0;
        start = i + 1;
    }
    wchar_t drive[] = { text[0], L':', L'\\', 0 };
    return GetDriveTypeW(drive) == DRIVE_FIXED;
}
static int security(HANDLE handle, int require_private, int ancestor, int volume_root) {
    PSID owner = NULL; PACL dacl = NULL; PSECURITY_DESCRIPTOR descriptor = NULL;
    DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &dacl, NULL, &descriptor);
    if (result != ERROR_SUCCESS) return failure("acl", result);
    int ok = owner && IsValidSid(owner) && (require_private ? EqualSid(owner, current_sid) : allowed_sid(owner, ancestor));
    if (!dacl || !IsValidAcl(dacl)) ok = 0;
    GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
    for (DWORD index = 0; ok && index < dacl->AceCount; ++index) {
        void *raw = NULL;
        if (!GetAce(dacl, index, &raw)) { ok = 0; break; }
        ACE_HEADER *header = (ACE_HEADER *) raw;
        if (header->AceFlags & INHERIT_ONLY_ACE) continue;
        if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { ok = 0; break; }
        ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *) raw;
        PSID sid = &ace->SidStart;
        if (!IsValidSid(sid)) { ok = 0; break; }
        if (allowed_sid(sid, ancestor)) continue;
        DWORD mask = ace->Mask; MapGenericMask(&mask, &mapping);
        DWORD dangerous = WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD;
        /* A fixed-volume root is not a replaceable directory entry. Its own
         * DELETE, attribute and EA permissions do not grant access to a private
         * child, whose complete chain is still held without SHARE_DELETE. Do
         * not apply this exception to a requested leaf or an ordinary ancestor;
         * root ACL/owner changes and child-delete grants remain forbidden. */
        if (!ancestor || !volume_root) dangerous |= DELETE | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
        if (!ancestor) dangerous |= FILE_WRITE_DATA | FILE_APPEND_DATA;
        if (require_private) dangerous |= FILE_READ_DATA | FILE_READ_EA | FILE_READ_ATTRIBUTES | READ_CONTROL | FILE_EXECUTE;
        if (mask & dangerous) ok = 0;
    }
    LocalFree(descriptor);
    return ok ? 1 : failure("acl", ERROR_ACCESS_DENIED);
}
static void close_lease(Lease *lease) {
    while (lease->count) { Pin *pin = &lease->pins[--lease->count]; CloseHandle(pin->handle); free(pin->path); }
    free(lease->pins); memset(lease, 0, sizeof(*lease));
}
static int open_component(Lease *lease, const wchar_t *name, int leaf, DWORD modifying) {
    if (lease->count >= PIN_CAP) return failure("limit", ERROR_TOO_MANY_OPEN_FILES);
    wchar_t extended[PATH_CAP], actual[PATH_CAP];
    if (swprintf(extended, PATH_CAP, L"\\\\?\\%ls", name) < 0) return failure("path", ERROR_INVALID_NAME);
    // A metadata-only open does not participate in the read/write/delete share
    // accounting on Windows. Request data access so withholding SHARE_DELETE
    // actually prevents Node/libuv rename/unlink from replacing the path.
    DWORD access = GENERIC_READ;
    if (leaf) access |= modifying;
    DWORD sharing = FILE_SHARE_READ;
    if (!leaf || !(lease->flags & FLAG_IMMUTABLE) || (lease->flags & FLAG_DIRECTORY)) sharing |= FILE_SHARE_WRITE;
    HANDLE handle = CreateFileW(extended, access, sharing, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return failure("io", GetLastError());
    BY_HANDLE_FILE_INFORMATION info;
    DWORD length = GetFinalPathNameByHandleW(handle, actual, PATH_CAP, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!length || length >= PATH_CAP || !GetFileInformationByHandle(handle, &info)) { DWORD error = GetLastError(); CloseHandle(handle); return failure("io", error); }
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || _wcsicmp(actual, extended)
        || (!leaf && !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
        || (leaf && !modifying && !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != !!(lease->flags & FLAG_DIRECTORY))
        || (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks != 1)) {
        CloseHandle(handle); return failure("path", ERROR_INVALID_DATA);
    }
    int volume_root = !leaf && wcslen(name) == 3;
    if (((lease->flags & (FLAG_PRIVATE | FLAG_TRUSTED)) && !security(handle, leaf && (lease->flags & FLAG_PRIVATE), !leaf, volume_root))
        || (modifying && !leaf && !security(handle, 0, 1, volume_root))) { CloseHandle(handle); return 0; }
    Pin *pin = &lease->pins[lease->count];
    pin->path = _wcsdup(actual + 4);
    if (!pin->path) { CloseHandle(handle); return failure("limit", ERROR_NOT_ENOUGH_MEMORY); }
    pin->handle = handle; pin->identity = info; lease->count++;
    return 1;
}
static int open_path(Lease *lease, const wchar_t *name, unsigned flags, DWORD modifying) {
    memset(lease, 0, sizeof(*lease)); lease->flags = flags;
    if (!valid_path(name)) return failure("path", ERROR_INVALID_NAME);
    lease->pins = (Pin *) calloc(PIN_CAP, sizeof(Pin));
    if (!lease->pins) return failure("limit", ERROR_NOT_ENOUGH_MEMORY);
    wchar_t part[PATH_CAP]; size_t length = wcslen(name);
    memcpy(part, name, (length + 1) * sizeof(wchar_t));
    for (size_t i = 3; i <= length; ++i) {
        if (i != 3 && i != length && name[i] != L'\\') continue;
        wchar_t saved = part[i]; part[i] = 0;
        if (!open_component(lease, part, i == length, modifying)) { close_lease(lease); return 0; }
        part[i] = saved;
    }
    return 1;
}
static int check_lease(Lease *lease) {
    for (size_t i = 0; i < lease->count; ++i) {
        Pin *pin = &lease->pins[i]; BY_HANDLE_FILE_INFORMATION info; wchar_t actual[PATH_CAP];
        DWORD length = GetFinalPathNameByHandleW(pin->handle, actual, PATH_CAP, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (!length || length >= PATH_CAP || !GetFileInformationByHandle(pin->handle, &info)) return failure("io", GetLastError());
        if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT || info.dwVolumeSerialNumber != pin->identity.dwVolumeSerialNumber
            || info.nFileIndexHigh != pin->identity.nFileIndexHigh || info.nFileIndexLow != pin->identity.nFileIndexLow
            || !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != !!(pin->identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            || (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks != 1)
            || wcsncmp(actual, L"\\\\?\\", 4) || wcscmp(actual + 4, pin->path)) return failure("changed", ERROR_INVALID_DATA);
        int leaf = i + 1 == lease->count;
        int volume_root = !leaf && wcslen(pin->path) == 3;
        if ((lease->flags & (FLAG_PRIVATE | FLAG_TRUSTED)) && !security(pin->handle, leaf && (lease->flags & FLAG_PRIVATE), !leaf, volume_root)) return 0;
    }
    return 1;
}
static DWORD private_acl(HANDLE handle, DWORD attributes, int readonly) {
    EXPLICIT_ACCESSW entries[3]; memset(entries, 0, sizeof(entries));
    PSID trustees[3] = { current_sid, system_sid, administrators_sid };
    for (size_t i = 0; i < 3; ++i) {
        entries[i].grfAccessPermissions = readonly ? FILE_GENERIC_READ | FILE_GENERIC_EXECUTE : FILE_ALL_ACCESS;
        entries[i].grfAccessMode = SET_ACCESS;
        entries[i].grfInheritance = (attributes & FILE_ATTRIBUTE_DIRECTORY) ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
        entries[i].Trustee.TrusteeForm = TRUSTEE_IS_SID; entries[i].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        entries[i].Trustee.ptstrName = (LPWSTR) trustees[i];
    }
    PACL dacl = NULL;
    DWORD result = SetEntriesInAclW(3, entries, NULL, &dacl);
    if (result == ERROR_SUCCESS) result = SetSecurityInfo(handle, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, dacl, NULL);
    LocalFree(dacl);
    return result;
}
static int set_private(const wchar_t *name, int readonly) {
    Lease lease;
    if (!open_path(&lease, name, 0, WRITE_DAC)) return 0;
    Pin *pin = &lease.pins[lease.count - 1];
    PSID owner = NULL; PSECURITY_DESCRIPTOR descriptor = NULL;
    DWORD result = GetSecurityInfo(pin->handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, NULL, NULL, NULL, &descriptor);
    if (result != ERROR_SUCCESS || !owner || !allowed_sid(owner, 0)) {
        LocalFree(descriptor); close_lease(&lease); return failure("acl", result == ERROR_SUCCESS ? ERROR_ACCESS_DENIED : result);
    }
    LocalFree(descriptor);
    /* A read-only owner retains WRITE_DAC, but not WRITE_OWNER or attribute
     * access. Restore the trusted writable DACL before reopening the locked path
     * for those rights; the complete original path remains non-delete-shared. */
    result = private_acl(pin->handle, pin->identity.dwFileAttributes, 0);
    HANDLE writable = INVALID_HANDLE_VALUE;
    if (result == ERROR_SUCCESS) {
        if (!open_component(&lease, name, 1, WRITE_OWNER | FILE_WRITE_ATTRIBUTES)) result = error_code;
        else {
            Pin *reopened = &lease.pins[lease.count - 1];
            if (reopened->identity.dwVolumeSerialNumber != pin->identity.dwVolumeSerialNumber
                || reopened->identity.nFileIndexHigh != pin->identity.nFileIndexHigh
                || reopened->identity.nFileIndexLow != pin->identity.nFileIndexLow) result = ERROR_INVALID_DATA;
            else writable = reopened->handle;
        }
    }
    if (result == ERROR_SUCCESS) result = SetSecurityInfo(writable, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION, current_sid, NULL, NULL, NULL);
    if (result == ERROR_SUCCESS && !(pin->identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
        FILE_BASIC_INFO basic; memset(&basic, 0, sizeof(basic));
        basic.FileAttributes = readonly ? pin->identity.dwFileAttributes | FILE_ATTRIBUTE_READONLY : pin->identity.dwFileAttributes & ~(DWORD) FILE_ATTRIBUTE_READONLY;
        if (!basic.FileAttributes) basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
        if (!SetFileInformationByHandle(writable, FileBasicInfo, &basic, sizeof(basic))) result = GetLastError();
    }
    if (readonly) {
        DWORD restricted = private_acl(pin->handle, pin->identity.dwFileAttributes, 1);
        if (result == ERROR_SUCCESS) result = restricted;
    }
    int ok = result == ERROR_SUCCESS && check_lease(&lease) && security(pin->handle, 1, 0, 0);
    close_lease(&lease);
    return ok ? 1 : result == ERROR_SUCCESS ? 0 : failure("acl", result);
}
static int decimal(const char *text, uint64_t *value) {
    size_t length = strlen(text); *value = 0;
    if (!length || length > 20 || (length > 1 && *text == '0')) return 0;
    for (size_t i = 0; i < length; ++i) {
        if (text[i] < '0' || text[i] > '9') return 0;
        unsigned digit = (unsigned) (text[i] - '0');
        if (*value > (UINT64_MAX - digit) / 10) return 0;
        *value = *value * 10 + digit;
    }
    return 1;
}
static unsigned nibble(char c) { return c >= '0' && c <= '9' ? (unsigned) (c - '0') : c >= 'a' && c <= 'f' ? (unsigned) (c - 'a' + 10) : 16U; }
static int decode_path(const char *hex, wchar_t *out) {
    size_t length = strlen(hex);
    if (!length || length % 4 || length / 4 > 4096) return failure("path", ERROR_INVALID_NAME);
    for (size_t i = 0; i < length; i += 4) {
        unsigned a = nibble(hex[i]), b = nibble(hex[i + 1]), c = nibble(hex[i + 2]), d = nibble(hex[i + 3]);
        if ((a | b | c | d) > 15U) return failure("path", ERROR_INVALID_NAME);
        unsigned value = (a << 4) | b | (c << 12) | (d << 8);
        if (!value) return failure("path", ERROR_INVALID_NAME);
        out[i / 4] = (wchar_t) value;
    }
    out[length / 4] = 0; return 1;
}
static void print_path(const wchar_t *text) {
    for (size_t i = 0; text[i]; ++i) { unsigned c = (unsigned) text[i]; printf("%02x%02x", c & 255U, c >> 8); }
}
static Lease *find_lease(uint64_t token) { for (size_t i = 0; i < LEASE_CAP; ++i) if (leases[i].token == token) return &leases[i]; return NULL; }

int wmain(int argc, wchar_t **argv) {
    if (argc != 2 || wcscmp(argv[1], L"cocos4-fs-v1") || !init_sids()) return 64;
    /* The package launcher pins the executable before CreateProcess. Also keep
     * its own complete trusted path immutable for the service lifetime. */
    wchar_t executable[PATH_CAP]; Lease self;
    DWORD size = GetModuleFileNameW(NULL, executable, PATH_CAP);
    if (!size || size >= PATH_CAP || !open_path(&self, executable, FLAG_TRUSTED | FLAG_IMMUTABLE, 0)) return 73;
    char line[LINE_CAP];
    while (fgets(line, LINE_CAP, stdin)) {
        size_t length = strlen(line);
        if (!length || line[length - 1] != '\n') break;
        line[--length] = 0; if (length && line[length - 1] == '\r') line[--length] = 0;
        char *fields[5]; size_t count = 0; char *part = line;
        for (;;) { if (count == 5 || !*part) { count = 0; break; } fields[count++] = part; char *space = strchr(part, ' '); if (!space) break; *space = 0; part = space + 1; }
        uint64_t id;
        if (count < 2 || !decimal(fields[0], &id) || !id) break;
        int ok = 0; Lease *lease = NULL; wchar_t filename[PATH_CAP]; uint64_t value;
        if (count == 2 && !strcmp(fields[1], "H")) { printf("%llu OK cocos4-fs-v1\n", (unsigned long long) id); fflush(stdout); continue; }
        if (count == 4 && !strcmp(fields[1], "P") && decimal(fields[2], &value) && value < 16U && decode_path(fields[3], filename)) {
            for (size_t i = 0; i < LEASE_CAP; ++i) if (!leases[i].token) { lease = &leases[i]; break; }
            if (!lease || next_token == UINT64_MAX) failure("limit", ERROR_TOO_MANY_OPEN_FILES);
            else if (open_path(lease, filename, (unsigned) value, 0)) {
                lease->token = next_token++;
                printf("%llu OK %llu ", (unsigned long long) id, (unsigned long long) lease->token);
                print_path(lease->pins[lease->count - 1].path); putchar('\n'); fflush(stdout); continue;
            }
        } else if (count == 3 && (!strcmp(fields[1], "C") || !strcmp(fields[1], "R")) && decimal(fields[2], &value)) {
            lease = find_lease(value);
            if (!lease) failure("changed", ERROR_INVALID_HANDLE);
            else if (!strcmp(fields[1], "R")) { close_lease(lease); ok = 1; }
            else ok = check_lease(lease);
        } else if (count == 3 && (!strcmp(fields[1], "A") || !strcmp(fields[1], "O")) && decode_path(fields[2], filename)) ok = set_private(filename, !strcmp(fields[1], "O"));
        else failure("path", ERROR_INVALID_PARAMETER);
        if (ok) printf("%llu OK\n", (unsigned long long) id);
        else printf("%llu ERR %s %lu\n", (unsigned long long) id, error_kind, (unsigned long) error_code);
        fflush(stdout);
    }
    for (size_t i = 0; i < LEASE_CAP; ++i) if (leases[i].token) close_lease(&leases[i]);
    close_lease(&self); free(current_sid); LocalFree(system_sid); LocalFree(administrators_sid); LocalFree(installer_sid); LocalFree(creator_sid);
    return 0;
}
