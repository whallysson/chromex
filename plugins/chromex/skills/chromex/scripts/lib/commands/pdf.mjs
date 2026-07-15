// Gerar PDF da página via CDP

import { writeFileSync } from 'fs';
import { resolveArtifactPath, timestamp } from '../artifacts.mjs';

export async function pdfStr(cdp, sid, filePath) {
  const out = resolveArtifactPath(filePath || null, 'pdf', `page-${timestamp()}.pdf`);

  const { data } = await cdp.send('Page.printToPDF', {
    landscape: false,
    printBackground: true,
    preferCSSPageSize: true,
  }, sid);

  writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });
  return `PDF saved to ${out}`;
}
