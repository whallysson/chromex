// Download control via Browser domain

import { existsSync, mkdirSync } from 'fs';

export async function downloadStr(cdp, sid, action, path) {
  switch (action) {
    case 'allow': {
      const downloadPath = path || '/tmp/chromex-downloads';
      if (!existsSync(downloadPath)) mkdirSync(downloadPath, { recursive: true });
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath,
      }, sid);
      return `Downloads allowed. Path: ${downloadPath}`;
    }
    case 'deny':
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }, sid);
      return 'Downloads blocked.';
    case 'reset':
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }, sid);
      return 'Download behavior reset to default.';
    default:
      throw new Error('Usage: download <target> allow [path] | deny | reset');
  }
}
