const http = require('http');
const urls = [
  '/', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/api/overview', '/api/agents', '/api/skills', '/api/sessions',
  '/api/config', '/api/workflow', '/api/changelog', '/api/compliance',
  '/api/audit', '/api/health', '/api/version',
  '/api/design/stats', '/api/deepening/dashboard',
  '/api/collaboration/modes', '/api/collaboration/stats',
  '/api/command-router/stats', '/api/command-router/commands',
  '/api/sqlite/stats', '/api/memory/entries', '/api/memory/usage',
  '/api/programmable-hook/stats', '/api/context-compression/stats',
  '/api/user/profile', '/api/antipattern/rules',
  '/api/agent-monitor/stats', '/api/goal/stats',
  '/api/approval/pending', '/api/mcp/status',
];
let done = 0;
const errors = [];
let ok = 0;

const GLOBAL_TIMEOUT_MS = 30000;
const globalTimer = setTimeout(function() {
  console.log('\nGlobal timeout reached (' + (GLOBAL_TIMEOUT_MS / 1000) + 's), aborting...');
  console.log('Total: ' + urls.length + ' | OK: ' + ok + ' | Errors: ' + errors.length);
  if (errors.length) {
    console.log('\nFailed endpoints:');
    errors.forEach(function(e) { console.log('  ' + e); });
  }
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);

urls.forEach(function(u) {
  const req = http.get('http://127.0.0.1:3210' + u, function(res) {
    let d = '';
    res.on('data', function(c) { d += c; });
    res.on('end', function() {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        ok++;
      } else {
        errors.push(res.statusCode + ' ' + u + ' (' + d.substring(0, 60).replace(/\n/g, ' ') + ')');
      }
      done++;
      if (done === urls.length) {
        clearTimeout(globalTimer);
        console.log('Total: ' + urls.length + ' | OK: ' + ok + ' | Errors: ' + errors.length);
        if (errors.length) {
          console.log('\nFailed endpoints:');
          errors.forEach(function(err) { console.log('  ' + err); });
        }
        process.exit(errors.length ? 1 : 0);
      }
    });
  }).on('error', function(e) {
    if (req._harnessTimedOut) return;
    errors.push('ERR ' + u + ': ' + (e && e.message ? e.message : String(e)));
    done++;
    if (done === urls.length) {
      clearTimeout(globalTimer);
      console.log('Total: ' + urls.length + ' | OK: ' + ok + ' | Errors: ' + errors.length);
      if (errors.length) {
        console.log('\nFailed endpoints:');
        errors.forEach(function(errItem) { console.log('  ' + errItem); });
      }
      process.exit(errors.length ? 1 : 0);
    }
  });
  req.setTimeout(5000, function() {
    req._harnessTimedOut = true;
    req.destroy();
    errors.push('TIMEOUT ' + u);
    done++;
    if (done === urls.length) {
      clearTimeout(globalTimer);
      console.log('Total: ' + urls.length + ' | OK: ' + ok + ' | Errors: ' + errors.length);
      if (errors.length) {
        console.log('\nFailed endpoints:');
        errors.forEach(function(e) { console.log('  ' + e); });
      }
      process.exit(errors.length ? 1 : 0);
    }
  });
});
