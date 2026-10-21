/** Source-editor gestures that reveal the corresponding position in the preview. */
export type FollowCursorMode = 'singleClick' | 'doubleClick' | 'off';

export function isFollowCursorMode(value: unknown): value is FollowCursorMode {
  return value === 'singleClick' || value === 'doubleClick' || value === 'off';
}
