import { describe, expect, it } from 'vitest';
import { redactCommandArgs, redactHeaders, redactObject, redactUrl } from '../plugins/chromex/skills/chromex/scripts/lib/redaction.mjs';
import { redactPages } from '../plugins/chromex/skills/chromex/scripts/lib/browser.mjs';

describe('sensitive data redaction', () => {
  it('redacts values from form and input commands', () => {
    expect(redactCommandArgs('fill', ['#password', 'super-secret'])).toEqual(['#password', '<redacted>']);
    expect(redactCommandArgs('type', ['super-secret'])).toEqual(['<redacted>']);
    expect(redactCommandArgs('form', ['{"password":"super-secret"}'])).toEqual(['<redacted>']);
  });

  it('redacts authentication headers and sensitive URL values', () => {
    expect(redactHeaders({ Authorization: 'Bearer abc', Accept: 'application/json', Cookie: 'sid=abc' })).toEqual({
      Authorization: '<redacted>',
      Accept: 'application/json',
      Cookie: '<redacted>',
    });
    expect(redactUrl('https://example.test/callback?token=abc&mode=safe')).toContain('token=%3Credacted%3E');
    expect(redactUrl('https://example.test/callback?token=abc&mode=safe')).toContain('mode=safe');
  });

  it('redacts sensitive keys recursively', () => {
    expect(redactObject({ user: 'alice', nested: { accessToken: 'abc', enabled: true } })).toEqual({
      user: 'alice',
      nested: { accessToken: '<redacted>', enabled: true },
    });
  });

  it('preserves complete non-sensitive values while redacting secrets', () => {
    const description = 'a'.repeat(500);

    expect(redactObject({ description, accessToken: 'secret' })).toEqual({
      description,
      accessToken: '<redacted>',
    });
    expect(redactHeaders({ 'X-Debug-Context': description })['X-Debug-Context']).toBe(description);
  });

  it('redacts page URLs by default and reveals them only on explicit live output', () => {
    const pages = [{ targetId: 'target-1', title: 'Authorization: Bearer title-secret', url: 'https://example.test/callback?token=page-secret' }];

    expect(redactPages(pages)[0].url).not.toContain('page-secret');
    expect(redactPages(pages)[0].title).not.toContain('title-secret');
    expect(redactPages(pages, { includeSensitive: true })[0].url).toContain('page-secret');
    expect(redactPages(pages, { includeSensitive: true })[0].title).toContain('title-secret');
  });
});
