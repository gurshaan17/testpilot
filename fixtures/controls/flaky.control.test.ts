describe('randomness', () => {
  it('passes only sometimes', () => {
    expect(Math.random() > 0.5).toBe(true);
  });
});
