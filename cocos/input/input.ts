/*
 Copyright (c) 2011-2012 cocos2d-x.org
 Copyright (c) 2013-2016 Chukong Technologies Inc.
 Copyright (c) 2017-2023 Xiamen Yaji Software Co., Ltd.

 http://www.cocos2d-x.org

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights to
 use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 of the Software, and to permit persons to whom the Software is furnished to do so,
 subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/

import { EDITOR_NOT_IN_PREVIEW, HTML5 } from 'internal:constants';
import { AccelerometerInputSource, GamepadInputDevice, HMDInputDevice, HandheldInputDevice,
    HandleInputDevice, KeyboardInputSource, MouseInputSource, TouchInputSource } from 'pal/input';
import { touchManager } from '../../pal/input/touch-manager';
import { EventTarget, error, sys } from '../core';
import { Event, EventAcceleration, EventGamepad, EventHandle, EventHandheld, EventHMD, EventKeyboard, EventMouse, EventTouch, Touch } from './types';
import { InputEventType } from './types/event-enum';

export enum EventDispatcherPriority {
    GLOBAL = 0,
    UI = 1,
}

export interface IEventDispatcher {
    /**
     * Priority to emit event to dispatcher
     */
    readonly priority: EventDispatcherPriority;
    /**
     * @param event
     * @returns Whether dispatch to next event dispatcher
     */
    dispatchEvent(event: Event): boolean;

    onThrowException(): void;
}

class InputEventDispatcher implements IEventDispatcher {
    public priority: EventDispatcherPriority = EventDispatcherPriority.GLOBAL;
    private declare _inputEventTarget: EventTarget;

    constructor (inputEventTarget: EventTarget) {
        this._inputEventTarget = inputEventTarget;
    }

    onThrowException (): void {
        // empty
    }

    public dispatchEvent (event: Event): boolean {
        this._inputEventTarget.emit(event.type, event);
        return true;
    }
}

const pointerEventTypeMap: Record<string, InputEventType> = {
    [InputEventType.MOUSE_DOWN]: InputEventType.TOUCH_START,
    [InputEventType.MOUSE_MOVE]: InputEventType.TOUCH_MOVE,
    [InputEventType.MOUSE_UP]: InputEventType.TOUCH_END,
};

export declare namespace Input {
    export type EventType = EnumAlias<typeof InputEventType>;
}

interface InputEventMap {
    [InputEventType.MOUSE_DOWN]: (event: EventMouse) => void,
    [InputEventType.MOUSE_MOVE]: (event: EventMouse) => void,
    [InputEventType.MOUSE_UP]: (event: EventMouse) => void,
    [InputEventType.MOUSE_WHEEL]: (event: EventMouse) => void,
    [InputEventType.TOUCH_START]: (event: EventTouch) => void,
    [InputEventType.TOUCH_MOVE]: (event: EventTouch) => void,
    [InputEventType.TOUCH_END]: (event: EventTouch) => void,
    [InputEventType.TOUCH_CANCEL]: (event: EventTouch) => void,
    [InputEventType.KEY_DOWN]: (event: EventKeyboard) => void,
    [InputEventType.KEY_PRESSING]: (event: EventKeyboard) => void,
    [InputEventType.KEY_UP]: (event: EventKeyboard) => void,
    [InputEventType.DEVICEMOTION]: (event: EventAcceleration) => void,
    [InputEventType.GAMEPAD_CHANGE]: (event: EventGamepad) => void,
    [InputEventType.GAMEPAD_INPUT]: (event: EventGamepad) => void,
    [InputEventType.HANDLE_INPUT]: (event: EventHandle) => void,
    [InputEventType.HANDLE_POSE_INPUT]: (event: EventHandle) => void,
    [InputEventType.HMD_POSE_INPUT]: (event: EventHMD) => void,
    [InputEventType.HANDHELD_POSE_INPUT]: (event: EventHandheld) => void,
}

/**
 * @en
 * This Input class manages all events of input. include: touch, mouse, accelerometer, gamepad, handle, hmd and keyboard.
 * You can get the `Input` instance with `input`.
 *
 * @zh
 * 该输入类管理所有的输入事件，包括：触摸、鼠标、加速计、游戏手柄、6DOF手柄、头戴显示器 和 键盘。
 * 你可以通过 `input` 获取到 `Input` 的实例。
 *
 * @example
 * ```
 * input.on(InputEventType.DEVICEMOTION, this.onDeviceMotionEvent, this);
 * input.off(InputEventType.DEVICEMOTION, this.onDeviceMotionEvent, this);
 * ```
 */
export class Input {
    /**
     * @en The input event type
     * @zh 输入事件类型
     */
    public static EventType = InputEventType;

    private _eventTarget: EventTarget = new EventTarget();
    private _touchInput = new TouchInputSource();
    private _mouseInput = new MouseInputSource();
    private _keyboardInput = new KeyboardInputSource();
    private _accelerometerInput = new AccelerometerInputSource();

    private declare _handleInput: HandleInputDevice;
    private declare _hmdInput: HMDInputDevice;
    private declare _handheldInput: HandheldInputDevice;

    private _needSimulateTouchMoveEvent = false;

    private declare _inputEventDispatcher: InputEventDispatcher;
    private _eventDispatcherList: IEventDispatcher[] = [];

    constructor () {
        if (HTML5) {
            this._handleInput = new HandleInputDevice();
            this._hmdInput = new HMDInputDevice();
            this._handheldInput = new HandheldInputDevice();
        }
        this._registerEvent();
        this._inputEventDispatcher = new InputEventDispatcher(this._eventTarget);
        this._registerEventDispatcher(this._inputEventDispatcher);
        if (HTML5) {
            GamepadInputDevice._init();
        }
    }

    /**
     * This should be a private method, but it's exposed for Editor Only.
     */
    private _dispatchMouseDownEvent (nativeMouseEvent: any): void {
        this._mouseInput.dispatchMouseDownEvent?.(nativeMouseEvent);
    }
    /**
     * This should be a private method, but it's exposed for Editor Only.
     */
    private _dispatchMouseMoveEvent (nativeMouseEvent: any): void {
        this._mouseInput.dispatchMouseMoveEvent?.(nativeMouseEvent);
    }
    /**
     * This should be a private method, but it's exposed for Editor Only.
     */
    private _dispatchMouseUpEvent (nativeMouseEvent: any): void {
        this._mouseInput.dispatchMouseUpEvent?.(nativeMouseEvent);
    }
    /**
     * This should be a private method, but it's exposed for Editor Only.
     */
    private _dispatchMouseScrollEvent (nativeMouseEvent: any): void {
        this._mouseInput.dispatchScrollEvent?.(nativeMouseEvent);
    }

    /**
     * This should be a private method, but it's exposed for Editor Only.
     */
    private _dispatchKeyboardDownEvent (nativeKeyboardEvent: any): void {
        this._keyboardInput.dispatchKeyboardDownEvent?.(nativeKeyboardEvent);
    }
    /**
     * This should be a private method, but it's exposed for Editor Only.
     */
    private _dispatchKeyboardUpEvent (nativeKeyboardEvent: any): void {
        this._keyboardInput.dispatchKeyboardUpEvent?.(nativeKeyboardEvent);
    }

    /**
     * @en
     * Register a callback of a specific input event type.
     * @zh
     * 注册特定的输入事件回调。
     *
     * @param eventType - The event type
     * @param callback - The event listener's callback
     * @param target - The event listener's target and callee
     */
    public on<K extends keyof InputEventMap> (eventType: K, callback: InputEventMap[K], target?: any): InputEventMap[K] {
        this._eventTarget.on(eventType, callback, target);
        return callback;
    }

    /**
     * @en
     * Register a callback of a specific input event type once.
     * @zh
     * 注册单次的输入事件回调。
     *
     * @param eventType - The event type
     * @param callback - The event listener's callback
     * @param target - The event listener's target and callee
     */
    public once<K extends keyof InputEventMap> (eventType: K, callback: InputEventMap[K], target?: any): InputEventMap[K] {
        this._eventTarget.once(eventType, callback, target);
        return callback;
    }

    /**
     * @en
     * Unregister a callback of a specific input event type.
     * @zh
     * 取消注册特定的输入事件回调。
     *
     * @param eventType - The event type
     * @param callback - The event listener's callback
     * @param target - The event listener's target and callee
     */
    public off<K extends keyof InputEventMap> (eventType: K, callback?: InputEventMap[K], target?: any): void {
        if (EDITOR_NOT_IN_PREVIEW) {
            return;
        }
        this._eventTarget.off(eventType, callback, target);
    }

    /**
     * @en
     * Get touch object by touch ID.
     * @zh
     * 通过 touch ID 获取 touch对象。
     */
    public getTouch (touchID: number): Readonly<Touch> | undefined {
        return touchManager.getTouch(touchID);
    }

    /**
     * @en
     * Get all the current touches objects as array.
     * @zh
     * 获取当前 所有touch对象 的数组。
     */
    public getAllTouches (): Touch[] {
        return touchManager.getAllTouches();
    }

    /**
     * @en
     * Get the number of touches.
     * @zh
     * 获取当前 touch 对象的数量。
     */
    public getTouchCount (): number {
        return touchManager.getTouchCount();
    }

    /**
     * @en
     * Sets whether to enable the accelerometer event listener or not.
     *
     * @zh
     * 是否启用加速度计事件。
     */
    public setAccelerometerEnabled (isEnable: boolean): void {
        if (EDITOR_NOT_IN_PREVIEW) {
            return;
        }
        if (isEnable) {
            this._accelerometerInput.start();
        } else {
            this._accelerometerInput.stop();
        }
    }

    /**
     * @en
     * Sets the accelerometer interval value.
     *
     * @zh
     * 设置加速度计间隔值。
     */
    public setAccelerometerInterval (intervalInMileSeconds: number): void {
        if (EDITOR_NOT_IN_PREVIEW) {
            return;
        }
        this._accelerometerInput.setInterval(intervalInMileSeconds);
    }

    private _simulateEventTouch (eventMouse: EventMouse): void {
        const eventType = pointerEventTypeMap[eventMouse.type];
        const touchID = 0;
        const touch = touchManager.getOrCreateTouch(touchID, eventMouse.getLocationX(), eventMouse.getLocationY());
        if (!touch) {
            return;
        }
        const changedTouches = [touch];
        const eventTouch = new EventTouch(changedTouches, false, eventType, (eventType === InputEventType.TOUCH_END ? [] : changedTouches));
        eventTouch.windowId = eventMouse.windowId;

        if (eventType === InputEventType.TOUCH_END) {
            touchManager.releaseTouch(touchID);
        }
        this._dispatchEventTouch(eventTouch);
    }

    /**
     * @engineInternal
     */
    public _registerEventDispatcher (eventDispatcher: IEventDispatcher): void {
        this._eventDispatcherList.push(eventDispatcher);
        this._eventDispatcherList.sort((a, b): number => b.priority - a.priority);
    }

    private _emitEvent (event: Event): void {
        const length = this._eventDispatcherList.length;
        for (let i = 0; i < length; ++i) {
            const dispatcher = this._eventDispatcherList[i];
            try {
                if (!dispatcher.dispatchEvent(event)) {
                    break;
                }
            } catch (e: any) {
                dispatcher.onThrowException();
                throw e;
            }
        }
    }

    private _registerEvent (): void {
        const self = this;
        const touchInput = self._touchInput;
        const mouseInput = self._mouseInput;
        const keyboardInput = self._keyboardInput;
        const handleInput = self._handleInput;
        if (sys.hasFeature(sys.Feature.INPUT_TOUCH)) {
            touchInput.on(InputEventType.TOUCH_START, (event): void => {
                self._dispatchEventTouch(event);
            });
            touchInput.on(InputEventType.TOUCH_MOVE, (event): void => {
                self._dispatchEventTouch(event);
            });
            touchInput.on(InputEventType.TOUCH_END, (event): void => {
                self._dispatchEventTouch(event);
            });
            touchInput.on(InputEventType.TOUCH_CANCEL, (event): void => {
                self._dispatchEventTouch(event);
            });
        }

        if (sys.hasFeature(sys.Feature.EVENT_MOUSE)) {
            mouseInput.on(InputEventType.MOUSE_DOWN, (event): void => {
                self._needSimulateTouchMoveEvent = true;
                self._simulateEventTouch(event);
                self._dispatchEventMouse(event);
            });
            mouseInput.on(InputEventType.MOUSE_MOVE, (event): void => {
                if (self._needSimulateTouchMoveEvent) {
                    self._simulateEventTouch(event);
                }
                self._dispatchEventMouse(event);
            });
            mouseInput.on(InputEventType.MOUSE_UP, (event): void => {
                self._needSimulateTouchMoveEvent = false;
                self._simulateEventTouch(event);
                self._dispatchEventMouse(event);
            });
            mouseInput.on(InputEventType.MOUSE_WHEEL, (event): void => {
                self._dispatchEventMouse(event);
            });
            mouseInput.on(InputEventType.MOUSE_LEAVE, (event): void => {
                self._dispatchEventMouse(event);
            });
            mouseInput.on(InputEventType.MOUSE_ENTER, (event): void => {
                self._dispatchEventMouse(event);
            });
        }

        if (sys.hasFeature(sys.Feature.EVENT_KEYBOARD)) {
            keyboardInput.on(InputEventType.KEY_DOWN, (event): void => {
                self._emitEvent(event);
            });
            keyboardInput.on(InputEventType.KEY_PRESSING, (event): void => {
                self._emitEvent(event);
            });
            keyboardInput.on(InputEventType.KEY_UP, (event): void => {
                self._emitEvent(event);
            });
        }

        if (sys.hasFeature(sys.Feature.EVENT_ACCELEROMETER)) {
            self._accelerometerInput.on(InputEventType.DEVICEMOTION, (event): void => {
                self._emitEvent(event);
            });
        }

        if (HTML5) {
            if (sys.hasFeature(sys.Feature.EVENT_GAMEPAD)) {
                GamepadInputDevice._on(InputEventType.GAMEPAD_CHANGE, (event): void => {
                    self._emitEvent(event);
                });
                GamepadInputDevice._on(InputEventType.GAMEPAD_INPUT, (event): void => {
                    self._emitEvent(event);
                });
                GamepadInputDevice._on(InputEventType.HANDLE_POSE_INPUT, (event): void => {
                    self._emitEvent(event);
                });
            }

            if (sys.hasFeature(sys.Feature.EVENT_HANDLE)) {
                handleInput._on(InputEventType.HANDLE_INPUT, (event): void => {
                    self._emitEvent(event);
                });
                handleInput._on(InputEventType.HANDLE_POSE_INPUT, (event): void => {
                    self._emitEvent(event);
                });
            }

            if (sys.hasFeature(sys.Feature.EVENT_HMD)) {
                self._hmdInput._on(InputEventType.HMD_POSE_INPUT, (event): void => {
                    self._emitEvent(event);
                });
            }

            if (sys.hasFeature(sys.Feature.EVENT_HANDHELD)) {
                self._handheldInput._on(InputEventType.HANDHELD_POSE_INPUT, (event): void => {
                    self._emitEvent(event);
                });
            }
        }
    }

    private _dispatchEventMouse (event: Event): void {
        this._emitEvent(event);
    }

    private _dispatchEventTouch (eventTouch: EventTouch): void {
        const touches = eventTouch.getTouches();
        const touchesLength = touches.length;
        for (let i = 0; i < touchesLength; ++i) {
            eventTouch.touch = touches[i];
            eventTouch.propagationStopped = eventTouch.propagationImmediateStopped = false;
            this._emitEvent(eventTouch);
        }
    }
}

/**
 * @en
 * The singleton of the Input class, this singleton manages all events of input. include: touch, mouse, accelerometer, gamepad, handle, hmd and keyboard.
 *
 * @zh
 * 输入类单例，该单例管理所有的输入事件，包括：触摸、鼠标、加速计、游戏手柄、6DOF手柄、头戴显示器 和 键盘。
 *
 * @example
 * ```
 * input.on(InputEventType.DEVICEMOTION, this.onDeviceMotionEvent, this);
 * input.off(InputEventType.DEVICEMOTION, this.onDeviceMotionEvent, this);
 * ```
 */
export const input = new Input();
