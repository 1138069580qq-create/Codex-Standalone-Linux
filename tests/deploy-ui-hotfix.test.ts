import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
test('UI hotfix validates before modifying/restarting live service and preserves lockfile changes',()=>{
 const source=readFileSync(path.resolve('scripts/deploy-ui-hotfix.sh'),'utf8');
 assert.ok(source.indexOf('PREFLIGHT=passed')<source.indexOf('git merge --ff-only'));
 assert.ok(source.indexOf('PREFLIGHT=passed')<source.indexOf('systemctl --user restart'));
 assert.doesNotMatch(source,/^\s*(?:systemctl --user stop|npm (?:ci|install)|git reset --hard|rm -rf)/m);
 assert.match(source,/git merge-base --is-ancestor/);assert.match(source,/package-lock\.before\.json/);assert.match(source,/git stash push[^\n]*-- package-lock\.json/);
 assert.match(source,/seq 1 60/);assert.match(source,/127\.0\.0\.1:3210\/healthz/);assert.match(source,/v4\.daodao\.eqad\.fun:26103/);assert.match(source,/PUBLIC_VERIFICATION=passed/);
 assert.match(source,/turn-ui\.test\.ts tests\/turn-service\.test\.ts tests\/preview-native\.test\.ts/);
});
