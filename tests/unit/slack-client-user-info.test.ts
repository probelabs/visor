import { SlackClient } from '../../src/slack/client';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('SlackClient.getUserInfo', () => {
  let client: SlackClient;

  beforeEach(() => {
    client = new SlackClient('xoxb-test-token');
    mockFetch.mockReset();
  });

  test('returns user info with all fields', async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          user: {
            id: 'U12345',
            name: 'testuser',
            real_name: 'Test User',
            profile: {
              email: 'test@example.com',
              real_name: 'Test User Profile',
            },
            is_restricted: false,
            is_ultra_restricted: false,
            is_bot: false,
            is_app_user: false,
            deleted: false,
          },
        }),
    });

    const result = await client.getUserInfo('U12345');

    expect(result.ok).toBe(true);
    expect(result.user).toEqual({
      id: 'U12345',
      name: 'testuser',
      real_name: 'Test User',
      email: 'test@example.com',
      is_restricted: false,
      is_ultra_restricted: false,
      is_bot: false,
      is_app_user: false,
      deleted: false,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/users.info',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-test-token',
        }),
      })
    );
  });

  test('identifies single-channel guest (is_ultra_restricted)', async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          user: {
            id: 'UGUEST1',
            name: 'guestuser',
            is_restricted: false,
            is_ultra_restricted: true, // single-channel guest
          },
        }),
    });

    const result = await client.getUserInfo('UGUEST1');

    expect(result.ok).toBe(true);
    expect(result.user?.is_ultra_restricted).toBe(true);
    expect(result.user?.is_restricted).toBe(false);
  });

  test('identifies multi-channel guest (is_restricted)', async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          user: {
            id: 'UGUEST2',
            name: 'mcguest',
            is_restricted: true, // multi-channel guest
            is_ultra_restricted: false,
          },
        }),
    });

    const result = await client.getUserInfo('UGUEST2');

    expect(result.ok).toBe(true);
    expect(result.user?.is_restricted).toBe(true);
    expect(result.user?.is_ultra_restricted).toBe(false);
  });

  test('handles API error response', async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: false,
          error: 'user_not_found',
        }),
    });

    const result = await client.getUserInfo('UINVALID');

    expect(result.ok).toBe(false);
    expect(result.user).toBeUndefined();
  });

  test('handles network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    const result = await client.getUserInfo('U12345');

    expect(result.ok).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Slack users.info failed'));
    consoleSpy.mockRestore();
  });

  test('handles missing profile.email gracefully', async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          user: {
            id: 'U12345',
            name: 'noemail',
            // No profile or email
          },
        }),
    });

    const result = await client.getUserInfo('U12345');

    expect(result.ok).toBe(true);
    expect(result.user?.email).toBeUndefined();
  });

  test('uses profile.real_name as fallback when real_name is missing', async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          user: {
            id: 'U12345',
            name: 'testuser',
            // No top-level real_name
            profile: {
              real_name: 'Profile Real Name',
            },
          },
        }),
    });

    const result = await client.getUserInfo('U12345');

    expect(result.ok).toBe(true);
    expect(result.user?.real_name).toBe('Profile Real Name');
  });
});
