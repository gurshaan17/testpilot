describe('runaway loop', () => {
  it('never returns', () => {
    let spins = 0;
    while (true) {
      spins += 1;
    }
    expect(spins).toBeGreaterThan(0);
  });
});
