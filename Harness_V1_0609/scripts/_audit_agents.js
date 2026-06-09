const fs = require('fs');
const files = fs.readdirSync('./.harness/agents').filter(f => f.endsWith('.md'));
console.log('Total agent files:', files.length);
const cats = {};
files.forEach(f => {
  const content = fs.readFileSync('./.harness/agents/' + f, 'utf8');
  const m = content.match(/type:\s*(\w[-.\w]*)/);
  const t = m ? m[1] : 'unknown';
  cats[t] = (cats[t] || 0) + 1;
  console.log('  ' + f.replace('.md', '') + ' -> ' + t);
});
console.log('Categories:', JSON.stringify(cats));
console.log('Sum:', Object.values(cats).reduce((a, b) => a + b, 0));
