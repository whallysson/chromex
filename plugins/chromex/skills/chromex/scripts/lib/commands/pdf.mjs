// Gerar PDF da página via CDP

import { writeFileSync } from 'fs';

export async function pdfStr(cdp, sid, filePath) {
  const out = filePath || '/tmp/page.pdf';

  const { data } = await cdp.send('Page.printToPDF', {
    landscape: false,
    printBackground: true,
    preferCSSPageSize: true,
  }, sid);

  writeFileSync(out, Buffer.from(data, 'base64'));
  return `PDF saved to ${out}`;
}
