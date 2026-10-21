import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { cfg, followCursorMode, setFollowCursorMode } from '../../src/config';

/** Exercise migration and toolbar persistence against the real, isolated VS Code settings
 * service. A global write can look successful while a workspace override still wins. */
export async function testFollowConfig(scope: vscode.Uri): Promise<void> {
  const keys = ['followCursor', 'syncCursor'] as const;
  const targets = [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace];
  // In a single-folder window, Workspace already represents .vscode/settings.json.
  // A multi-root workspace has an additional, independent folder setting to preserve.
  if (vscode.workspace.workspaceFile && vscode.workspace.getWorkspaceFolder(scope)) targets.push(vscode.ConfigurationTarget.WorkspaceFolder);
  const readTarget = (key: typeof keys[number], target: vscode.ConfigurationTarget) => {
    const inspected = cfg(scope).inspect(key);
    return target === vscode.ConfigurationTarget.Global ? inspected?.globalValue
      : target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue
      : inspected?.workspaceFolderValue;
  };
  const saved = keys.flatMap((key) => targets
    .filter((target) => key === 'followCursor' || target !== vscode.ConfigurationTarget.WorkspaceFolder)
    .map((target) => ({ key, target, value: readTarget(key, target) })));
  const update = (key: typeof keys[number], value: unknown, target = vscode.ConfigurationTarget.Global) => cfg(scope).update(key, value, target);
  try {
    for (const { key, target } of saved) await update(key, undefined, target);
    assert.equal(followCursorMode(scope), 'doubleClick', 'a fresh installation defaults to double-click');
    assert.equal(cfg(scope).get('followCursor'), 'doubleClick', 'the settings UI and resolver share the same default');

    await update('syncCursor', false);
    assert.equal(followCursorMode(scope), 'off', 'an existing disabled follow preference stays off');
    await update('syncCursor', true);
    assert.equal(followCursorMode(scope), 'doubleClick', 'an existing enabled preference uses the new default');

    await update('syncCursor', false);
    for (const mode of ['singleClick', 'doubleClick', 'off'] as const) {
      await update('followCursor', mode);
      assert.equal(followCursorMode(scope), mode, 'an explicitly selected mode overrides legacy false');
    }

    await update('followCursor', 'singleClick');
    await update('followCursor', 'off', vscode.ConfigurationTarget.Workspace);
    assert.equal(followCursorMode(scope), 'off', 'the workspace mode overrides the global mode');
    await setFollowCursorMode('doubleClick', scope);
    assert.equal(followCursorMode(scope), 'doubleClick', 'a toolbar change takes effect through the workspace override');
    assert.equal(readTarget('followCursor', vscode.ConfigurationTarget.Workspace), 'doubleClick', 'the toolbar updates the workspace setting');
    assert.equal(readTarget('followCursor', vscode.ConfigurationTarget.Global), 'singleClick', 'the toolbar leaves the global preference unchanged');

    await update('followCursor', undefined, vscode.ConfigurationTarget.Workspace);
    await update('followCursor', undefined);
    await update('syncCursor', undefined);
    await update('syncCursor', false, vscode.ConfigurationTarget.Workspace);
    assert.equal(followCursorMode(scope), 'off', 'a disabled workspace legacy preference is respected');
    await setFollowCursorMode('singleClick', scope);
    assert.equal(followCursorMode(scope), 'singleClick', 'choosing a mode migrates the workspace legacy preference');
    assert.equal(readTarget('followCursor', vscode.ConfigurationTarget.Workspace), 'singleClick');
    assert.equal(readTarget('followCursor', vscode.ConfigurationTarget.Global), undefined, 'workspace migration creates no global override');
    assert.equal(readTarget('syncCursor', vscode.ConfigurationTarget.Workspace), false, 'the legacy setting remains available for migration');
  } finally {
    for (const { key, target, value } of saved) await update(key, value, target);
  }
}
