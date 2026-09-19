import { Recommendation } from './ai-client';

/** Recomendaciones genéricas y seguras que se devuelven cuando el ai-service no responde a tiempo. */
export const FALLBACK_RECOMMENDATIONS: Recommendation[] = [
  {
    id: 'FALLBACK_ALERTS',
    type: 'general',
    severity: 'info',
    title: 'Activa las alertas de movimientos',
    message: 'Recibe un aviso por cada transferencia para detectar a tiempo cualquier operación desconocida.',
  },
  {
    id: 'FALLBACK_BUDGET',
    type: 'budget',
    severity: 'info',
    title: 'Define un presupuesto mensual',
    message: 'Fijar un límite por categoría te ayuda a controlar tus gastos.',
  },
  {
    id: 'FALLBACK_SAVINGS',
    type: 'saving',
    severity: 'info',
    title: 'Ahorra de forma automática',
    message: 'Programa una transferencia periódica a tu cuenta de ahorros.',
  },
];
