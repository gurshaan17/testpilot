import { reset, seed } from '../src/users/userRepository';
import { getPublicProfile } from '../src/users/userProfileService';

describe('public profile endpoint', () => {
  beforeEach(() => {
    reset();
    seed([
      {
        id: 'usr_1',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        passwordHash: 'correct-horse',
        active: true
      }
    ]);
  });

  it('returns the public display name', async () => {
    await expect(getPublicProfile('usr_1')).resolves.toEqual({
      id: 'usr_1',
      displayName: 'Ada Lovelace'
    });
  });
});
