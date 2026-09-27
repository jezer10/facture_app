import { createApp } from 'vue';
import '@fontsource-variable/manrope';
import './styles/main.css';
import App from './app/App.vue';
import { router } from './app/router';

import { refreshSession } from './features/session/session';

void refreshSession()
  .catch(() => undefined)
  .then(() => {
    createApp(App).use(router).mount('#app');
  });
