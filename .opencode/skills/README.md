# Cocos4 Development Skills

These two skills describe this mini-game-only fork, not generic upstream Cocos.
They are repository-owned instructions with on-demand references and examples.

| Skill | Use for | Do not confuse with |
| --- | --- | --- |
| [cocos4-engine-dev](cocos4-engine-dev/SKILL.md) | Engine source, public API, rendering, PAL, build tooling, declarations, regression tests | Writing a game's rules and screens |
| [cocos4-minigame-dev](cocos4-minigame-dev/SKILL.md) | Game components, assets, UI/input, physics, performance, Creator/vendor acceptance | Building or publishing the engine itself |

OpenCode discovers `.opencode/skills/*/SKILL.md` in this repository. Quit and
restart OpenCode after adding or updating skills; the current session may keep
its previously loaded catalog. No project config or global permissions need to
change for repository-local use.

For another game repository, merge this entry into its existing `opencode.json`
using the actual absolute engine checkout path. Do not replace unrelated config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": {
    "paths": ["/absolute/path/to/cocos4/.opencode/skills"]
  }
}
```

The game repository remains the working project. The engine checkout is a
reference/dependency, not the destination for game scripts. Skill registration
does not itself grant access to external directories; follow normal permissions.

Example requests:

- "Use cocos4-engine-dev to fix UITransform dirty propagation and add a regression test."
- "Use cocos4-engine-dev to investigate a ccbuild declaration regression."
- "Use cocos4-minigame-dev to implement a pooled enemy wave and safe level teardown."
- "Use cocos4-minigame-dev to diagnose WeChat touch cancellation and OPPO background audio."

Run these commands from the engine checkout root, not the game project, to
type-check the two examples against this checkout's generated public API:

```sh
npm run build:declaration
node .opencode/skills/cocos4-minigame-dev/scripts/check-examples.cjs
```

This checks types, not asset import, scene wiring, touch behavior, or rendering.
The checker also accepts an engine root argument when the skill lives elsewhere.
Keep the entire skill directory, including references, examples and scripts,
together when distributing it. Recheck source-backed claims after engine upgrades.
