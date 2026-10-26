import { __reset, createOrder, getOrder } from '../src/orders/orderRepository';
import { processPayment } from '../src/payments/processPayment';

describe('declined charge must not mark the order paid', () => {
  beforeEach(() => {
    __reset();
  });

  it('leaves the order pending when the gateway declines', async () => {
    const order = createOrder({
      customerId: 'cus_1',
      total: 50,
      cardToken: 'tok_declined'
    });

    await expect(processPayment(order)).rejects.toThrow('Payment declined');
    expect(getOrder(order.id)?.status).toBe('pending');
  });
});
