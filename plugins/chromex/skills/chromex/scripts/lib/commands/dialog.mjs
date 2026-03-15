// Dialog handling (alert/confirm/prompt) via Page domain

export async function dialogStr(cdp, sid, action, text) {
  await cdp.send('Page.enable', {}, sid);

  switch (action) {
    case 'accept':
      await cdp.send('Page.handleJavaScriptDialog', {
        accept: true,
        promptText: text || '',
      }, sid);
      return `Dialog accepted${text ? ` with text "${text}"` : ''}.`;

    case 'dismiss':
      await cdp.send('Page.handleJavaScriptDialog', { accept: false }, sid);
      return 'Dialog dismissed.';

    case 'auto':
      // Retorna flag para o daemon registrar auto-handler
      return '__AUTO_DIALOG__';

    default:
      throw new Error('Usage: dialog <target> accept [text] | dismiss | auto');
  }
}

// Registra handler permanente que auto-aceita dialogs
export function setupAutoDialog(cdp, sid) {
  cdp.onEvent('Page.javascriptDialogOpening', async (params) => {
    try {
      await cdp.send('Page.handleJavaScriptDialog', {
        accept: true,
        promptText: '',
      }, sid);
    } catch { /* dialog ja foi tratado */ }
  });
  return 'Auto-dialog enabled: all dialogs (alert/confirm/prompt) will be auto-accepted.';
}
