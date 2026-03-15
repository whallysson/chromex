// WebAuthn / Passkey testing via WebAuthn domain

let authenticatorId = null;

export async function webauthnStr(cdp, sid, action) {
  if (!action) throw new Error('Usage: webauthn <target> enable | creds | disable');

  switch (action) {
    case 'enable': {
      await cdp.send('WebAuthn.enable', { enableUI: false }, sid);
      const result = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      }, sid);
      authenticatorId = result.authenticatorId;
      return `Virtual authenticator created (id: ${authenticatorId}). Passkey flows will work automatically.`;
    }

    case 'creds': {
      if (!authenticatorId) throw new Error('No authenticator active. Run "webauthn enable" first.');
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId }, sid);
      if (credentials.length === 0) return 'No credentials stored.';
      return credentials.map((c, i) => {
        const id = Buffer.from(c.credentialId, 'base64').toString('hex').slice(0, 16);
        return `${i + 1}. ${id}  rpId=${c.rpId}  userHandle=${c.userHandle || 'none'}`;
      }).join('\n');
    }

    case 'disable': {
      if (authenticatorId) {
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }, sid);
        authenticatorId = null;
      }
      await cdp.send('WebAuthn.disable', {}, sid);
      return 'WebAuthn virtual authenticator removed.';
    }

    default:
      throw new Error('Usage: webauthn <target> enable | creds | disable');
  }
}
