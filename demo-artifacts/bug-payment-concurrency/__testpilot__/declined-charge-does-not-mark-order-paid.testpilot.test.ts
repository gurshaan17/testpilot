import { processPayment } from '../src/payments/processPayment';
import { chargeCustomer } from '../src/payments/gateway';
import { createOrder, getOrder, __reset } from '../src/orders/orderRepository';

jest.mock('../src/payments/gateway');

const mockedChargeCustomer = jest.mocked(chargeCustomer);

describe('processPayment - declined charge', () => {
  beforeEach(() => {
    __reset();
    mockedChargeCustomer.mockReset();
  });

  it('does not mark order as paid when customer charge fails', async () => {
    mockedChargeCustomer.mockRejectedValue(new Error('Card declined'));

    const order = createOrder({
      customerId: 'cus_1',
      total: 50,
      cardToken: 'tok_declined'
    });

    await expect(processPayment(order)).rejects.toThrow('Card declined');

    const storedOrder = getOrder(order.id);
    expect(storedOrder).toBeDefined();
    expect(storedOrder?.status).toBe('pending');
    expect(storedOrder?.status).not.toBe('paid');
  });
});
