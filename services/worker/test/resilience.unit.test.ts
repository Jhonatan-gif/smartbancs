import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/circuit-breaker';
import { RateLimiter } from '../src/rate-limiter';

describe('CircuitBreaker', () => {
  const boom = () => Promise.reject(new Error('fallo'));
  const ok = () => Promise.resolve('ok');

  it('se abre tras N fallos consecutivos y deja de llamar al legado', async () => {
    let t = 0;
    const breaker = new CircuitBreaker(3, 1000, () => t);
    for (let i = 0; i < 3; i++) await expect(breaker.exec(boom)).rejects.toThrow('fallo');
    expect(breaker.currentState).toBe('OPEN');

    let called = false;
    await expect(breaker.exec(async () => { called = true; })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false); // ni siquiera se intentó la llamada
  });

  it('pasa a HALF_OPEN tras el cooldown y se cierra si la prueba funciona', async () => {
    let t = 0;
    const breaker = new CircuitBreaker(2, 1000, () => t);
    for (let i = 0; i < 2; i++) await breaker.exec(boom).catch(() => {});
    t = 1001;
    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('vuelve a abrirse si la llamada de prueba falla', async () => {
    let t = 0;
    const breaker = new CircuitBreaker(2, 1000, () => t);
    for (let i = 0; i < 2; i++) await breaker.exec(boom).catch(() => {});
    t = 1001;
    await breaker.exec(boom).catch(() => {});
    expect(breaker.currentState).toBe('OPEN');
    await expect(breaker.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('los errores que no cuentan como fallo (429) no abren el circuito', async () => {
    const breaker = new CircuitBreaker(2, 1000);
    for (let i = 0; i < 5; i++) await breaker.exec(boom, () => false).catch(() => {});
    expect(breaker.currentState).toBe('CLOSED');
  });
});

describe('RateLimiter', () => {
  it('espacia las llamadas para no superar N por segundo', async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(5, () => t, async (ms) => { waits.push(ms); t += ms; });
    for (let i = 0; i < 6; i++) await limiter.acquire();
    // 1ª inmediata; las siguientes cada 200 ms => 5 llamadas por segundo
    expect(waits).toEqual([200, 200, 200, 200, 200]);
    expect(t).toBe(1000);
  });
});
