import { describe, it, expect } from 'vitest'
import { isSafeRedirectTarget, resolveSafeRedirectTarget } from './safeRedirect.js'
import { UnsafeRedirectError } from './errors.js'

describe('isSafeRedirectTarget', () => {
  describe('safe relative paths', () => {
    it('allows a plain root-relative path', () => {
      expect(isSafeRedirectTarget('/dashboard')).toBe(true)
    })

    it('allows a relative path with query string and fragment', () => {
      expect(isSafeRedirectTarget('/orgs/org-1/members?page=2#top')).toBe(true)
    })

    it('allows a relative path containing an encoded (non-control) character', () => {
      expect(isSafeRedirectTarget('/search?q=%20hello')).toBe(true)
    })
  })

  describe('allow-listed absolute URLs', () => {
    it('allows an absolute https URL whose host is allow-listed', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard', ['admin.credence.io'])).toBe(true)
    })

    it('rejects an absolute URL whose host is not allow-listed', () => {
      expect(isSafeRedirectTarget('https://evil.com/dashboard', ['admin.credence.io'])).toBe(false)
    })

    it('rejects any absolute URL when no allowlist is configured', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard')).toBe(false)
    })

    it('resolves userinfo host-confusion tricks to the real host, not the trusted-looking prefix', () => {
      // A naive `url.includes('admin.credence.io')` check would be fooled by this;
      // the real target host is evil.com.
      expect(isSafeRedirectTarget('https://admin.credence.io@evil.com/', ['admin.credence.io'])).toBe(false)
    })

    it('is case-insensitive when matching the allow-listed host', () => {
      expect(isSafeRedirectTarget('https://ADMIN.CREDENCE.IO/dashboard', ['admin.credence.io'])).toBe(true)
    })
  })

  describe('open-redirect attack vectors (negative cases)', () => {
    it('rejects a protocol-relative URL (//evil.com)', () => {
      expect(isSafeRedirectTarget('//evil.com', ['admin.credence.io'])).toBe(false)
    })

    it('rejects a triple-slash URL (///evil.com)', () => {
      expect(isSafeRedirectTarget('///evil.com')).toBe(false)
    })

    it('rejects the backslash-as-slash trick (/\\evil.com)', () => {
      expect(isSafeRedirectTarget('/\\evil.com')).toBe(false)
    })

    it('rejects a leading double backslash (\\\\evil.com)', () => {
      expect(isSafeRedirectTarget('\\\\evil.com')).toBe(false)
    })

    it('rejects a double-encoded protocol-relative URL (/%2F%2Fevil.com)', () => {
      expect(isSafeRedirectTarget('/%2F%2Fevil.com')).toBe(false)
    })

    it('rejects a javascript: URI', () => {
      expect(isSafeRedirectTarget('javascript:alert(document.domain)')).toBe(false)
    })

    it('rejects a data: URI', () => {
      expect(isSafeRedirectTarget('data:text/html,<script>alert(1)</script>')).toBe(false)
    })

    it('rejects a target containing a literal tab character (WHATWG tab-stripping bypass)', () => {
      expect(isSafeRedirectTarget('/\t/evil.com')).toBe(false)
    })

    it('rejects a target containing an encoded tab that decodes to a protocol-relative prefix', () => {
      expect(isSafeRedirectTarget('/%09/evil.com')).toBe(false)
    })

    it('rejects a target containing a literal newline', () => {
      expect(isSafeRedirectTarget('/foo\nbar')).toBe(false)
    })

    it('rejects an empty string', () => {
      expect(isSafeRedirectTarget('')).toBe(false)
    })

    it('rejects non-string input', () => {
      expect(isSafeRedirectTarget(undefined)).toBe(false)
      expect(isSafeRedirectTarget(null)).toBe(false)
      expect(isSafeRedirectTarget(123)).toBe(false)
      expect(isSafeRedirectTarget(['/dashboard'])).toBe(false)
    })

    it('rejects a malformed percent-encoded sequence instead of throwing', () => {
      expect(isSafeRedirectTarget('/%E0C%80')).toBe(false)
    })

    it('rejects a relative path that does not start with a slash', () => {
      expect(isSafeRedirectTarget('dashboard')).toBe(false)
    })
  })

  describe('boundary conditions', () => {
    it('allows the minimal root path', () => {
      expect(isSafeRedirectTarget('/')).toBe(true)
    })

    it('rejects a literal NUL byte in the target', () => {
      expect(isSafeRedirectTarget('/foo\u0000bar')).toBe(false)
    })

    it('rejects a literal DEL byte in the target', () => {
      expect(isSafeRedirectTarget('/foo\u007fbar')).toBe(false)
    })

    it('rejects a target whose decoded form contains a control character', () => {
      expect(isSafeRedirectTarget('/%00/evil.com')).toBe(false)
    })

    it('rejects a target whose decoded form is a backslash trick', () => {
      expect(isSafeRedirectTarget('/%5Cevil.com')).toBe(false)
    })

    it('rejects an absolute URL with a non-http(s) scheme even when the host is allow-listed', () => {
      expect(isSafeRedirectTarget('ftp://admin.credence.io/x', ['admin.credence.io'])).toBe(false)
    })

    it('rejects an absolute URL whose host differs only by port', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io:8080/x', ['admin.credence.io'])).toBe(false)
    })

    it('allows an absolute URL when the allowlist entry includes the explicit port', () => {
      expect(
        isSafeRedirectTarget('https://admin.credence.io:8080/x', ['admin.credence.io:8080'])
      ).toBe(true)
    })

    it('rejects a malformed absolute URL', () => {
      expect(isSafeRedirectTarget('https://[::invalid', ['admin.credence.io'])).toBe(false)
    })

    it('rejects an absolute URL against an empty allowlist', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/x', [])).toBe(false)
    })

    it('is deterministic across repeated invocations for the same input', () => {
      const inputs: unknown[] = ['/dashboard', '//evil.com', 'https://admin.credence.io/x', '/%2F%2Fevil.com']
      const allowed = ['admin.credence.io']
      const first = inputs.map((i) => isSafeRedirectTarget(i, allowed))
      const second = inputs.map((i) => isSafeRedirectTarget(i, allowed))
      expect(second).toEqual(first)
    })
  })
})

describe('resolveSafeRedirectTarget', () => {
  it('returns the target unchanged when safe', () => {
    expect(resolveSafeRedirectTarget('/dashboard')).toBe('/dashboard')
  })

  it('returns an allow-listed absolute URL unchanged', () => {
    expect(resolveSafeRedirectTarget('https://admin.credence.io/x', ['admin.credence.io'])).toBe(
      'https://admin.credence.io/x'
    )
  })

  it('throws UnsafeRedirectError for a protocol-relative target', () => {
    expect(() => resolveSafeRedirectTarget('//evil.com')).toThrow(UnsafeRedirectError)
  })

  it('surfaces a typed, catalog-backed error rather than a generic error', () => {
    let caught: unknown
    try {
      resolveSafeRedirectTarget('//evil.com')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnsafeRedirectError)
    const appError = caught as UnsafeRedirectError
    expect(appError.code).toBe('unsafe_redirect_target')
    expect(appError.status).toBe400)
  })

  it('throws for a disallowed absolute host', () => {
    expect(() => resolveSafeRedirectTarget('https://evil.com', ['admin.credence.io'])).toThrow(
      UnsafeRedirectError
    )
  })

  it('throws for an empty target', () => {
    expect(() => resolveSafeRedirectTarget('')).toThrow(UnsafeRedirectError)
  })

  it('throws for non-string input without leaking the value into the message', () => {
    let caught: unknown
    try {
      resolveSafeRedirectTarget({ secret: 'token' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInctanceOf(UnsafeRedirectError)
    const appError = caught as UnsafeRedirectError
    expect(appError.code).toBe('unsafe_redirect_target')
    expect(appError.status).toBe(400)
  })

  it('rejects an attacker-controlled target and leaves the caller free to recover', () => {
    // Recovery contract: a rejected target must not mutate any shared state,
    // so the caller can fall back to a safe default and retry.
    const fallback = '/dashboard'
    let resolved: string
    try {
      resolved = resolveSafeRedirectTarget('//evil.com')
    } catch {
      resolved = fallback
    }
    expect(resolved).toBe(fallback)
    // A second attempt with a valid target still succeeds.
    expect(resolveSafeRedirectTarget('/settings')).toBe(fallback.replace('dashboard', 'settings'))
  })

  it('returns the same value for duplicate invocations (idempotent)', () => {
    const first = resolveSafeRedirectTarget('/orgs/org-1?name=%20x')
    const second = resolveSafeRedirectTarget('/orgs/org-1?name=%20x')
    expect(second).toBe(first)
  })

  it('preserves the original encoding of a safe target (no normalization)', () => {
    const target = '/search?q=%20hello&utf8=%E2%9C%93'
    expect(resolveSafeRedirectTarget(target)).toBe(target)
  })

  it('propagates the typed failure for concurrent invalid inputs without interference', () => {
    const results = ['//evil.com', 'https://evil.com', '/\\evil.com'].map((target) => {
      try {
        resolveSafeRedirectTarget(target, ['admin.credence.io'])
        return 'ok'
      } catch (err) {
        return err instanceof UnsafeRedirectError ? err.code : 'unknown'
      }
    })
    expect(results).toEqual([''unsafe_redirect_target', 'unsafe_redirect_target', 'unsafe_redirect_target'])
  })
})
