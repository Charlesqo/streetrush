import {readFileSync,writeFileSync} from 'node:fs';
const html = readFileSync(new URL('../../index.html',import.meta.url),'utf8')
  .replace('</body>','<script type="module" src="./review.js"></script></body>');
writeFileSync(new URL('review.html',import.meta.url),html);
