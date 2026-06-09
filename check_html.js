const fs = require('fs');
const path = require('path');
const http = require('http');

const file = path.join('g:', 'DreamPatrol', 'Files', 'dimilinks-image-demo.html');
const html = fs.readFileSync(file, 'utf8');

// Quick static checks
const checks = [];
function check(name, cond, msg) {
  checks.push({ name, ok: cond, msg: msg || '' });
}

check('DOCTYPE present', /<!DOCTYPE html>/i.test(html));
check('html lang attr', /<html [^>]*lang=/.test(html));
check('head present', /<head>/.test(html) && /<\/head>/.test(html));
check('body present', /<body>/.test(html) && /<\/body>/.test(html));
check('style balanced',
  (html.match(/<style[\s>]/g) || []).length === (html.match(/<\/style>/g) || []).length);
check('script balanced',
  (html.match(/<script[\s>]/g) || []).length === (html.match(/<\/script>/g) || []).length);
check('div balanced',
  (html.match(/<div[\s>]/g) || []).length === (html.match(/<\/div>/g) || []).length);
check('button balanced',
  (html.match(/<button[\s>]/g) || []).length === (html.match(/<\/button>/g) || []).length);

// Look for raw '<' '>' inside <script> or <style> that could break parsing
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const s = scriptMatch[1];
  // Count of </script> substring inside
  check('no nested </script> in script', !s.includes('</script>'));
  // Naive check for syntax: any line starting with single quote mismatch
}

// Try parse with a JSDOM-free approach: load as module-less string and use a basic HTML parser
try {
  // Use URLSearchParams? No. Just check for invisible characters or weird BOM
  const bom = html.charCodeAt(0) === 0xFEFF;
  check('no BOM', !bom);
} catch (e) {
  check('readable', false, e.message);
}

console.log(JSON.stringify(checks, null, 2));
const failed = checks.filter(c => !c.ok);
console.log('\nFAILED:', failed.length);
process.exit(failed.length ? 1 : 0);
