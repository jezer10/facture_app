import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/facturas' },
    {
      path: '/empresas',
      component: () => import('@/features/companies/CompaniesView.vue'),
      meta: { title: 'Mis empresas' },
    },
    {
      path: '/facturas',
      component: () => import('@/features/invoices/views/InvoiceListView.vue'),
      meta: { title: 'Facturas' },
    },
    {
      path: '/facturas/nueva',
      component: () => import('@/features/invoices/views/InvoiceCreateView.vue'),
      meta: { title: 'Nueva factura' },
    },
    {
      path: '/facturas/:id',
      component: () => import('@/features/invoices/views/InvoiceDetailView.vue'),
      meta: { title: 'Detalle de factura' },
    },
    {
      path: '/conexion',
      component: () => import('@/features/session/ConnectionView.vue'),
      meta: { title: 'Conexión' },
    },
    {
      path: '/:pathMatch(.*)*',
      component: () => import('@/app/NotFoundView.vue'),
      meta: { title: 'Página no encontrada' },
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
router.afterEach((to) => {
  document.title = `FCTR · ${String(to.meta.title)}`;
  requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus());
});
