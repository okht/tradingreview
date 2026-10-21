import fs from 'node:fs';
import postcss from 'postcss';
const file='style.css';
const root=postcss.parse(fs.readFileSync(file,'utf8'));
root.walkRules(rule=>{
  rule.selectors=rule.selectors.map(s=>{
    if(s.startsWith(':root') || s.startsWith('.slidev-layout.tr-canvas') || s.startsWith('.shot-lightbox') || s.startsWith('.lightbox-') || s.startsWith('.slidev-vclick') || s==='*') return s;
    if(s.startsWith('.slidev-layout.tr-canvas')) return s;
    if(s.startsWith('.tr-canvas')) return s.replace('.tr-canvas','.slidev-layout.tr-canvas');
    return '.slidev-layout.tr-canvas '+s;
  });
});
fs.writeFileSync(file,root.toString());
const md=fs.readFileSync('slides.md','utf8').replace('  local: Microsoft YaHei','  local: [Microsoft YaHei]');fs.writeFileSync('slides.md',md);
