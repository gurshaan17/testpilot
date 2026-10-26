describe('type error', () => {
  it('does not compile', () => {
    const value: number = 'this is a string';
    expect(value).toBe('this is a string');
  });
});
