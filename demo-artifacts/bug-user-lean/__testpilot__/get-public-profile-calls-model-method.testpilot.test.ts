import { getPublicProfile } from '../src/users/userProfileService';
import { reset, seed } from '../src/users/userRepository';

describe('getPublicProfile', () => {
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

  it('retrieves the public profile via the user model instance method', async () => {
    const profile = await getPublicProfile('usr_1');
    expect(profile).toEqual({
      id: 'usr_1',
      displayName: 'Ada Lovelace'
    });
  });
});
