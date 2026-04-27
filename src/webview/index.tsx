import { render } from 'solid-js/web';
import { AppRoot } from './App';
// oxlint-disable-next-line no-unassigned-import
import './index.css';

const root = document.getElementById('root');
if (root) {
  render(() => <AppRoot />, root);
}
