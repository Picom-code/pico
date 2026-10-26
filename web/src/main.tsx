import { render } from 'preact';
import { App } from './App';
import { initTheme } from './theme';
import './styles.css';

initTheme();
render(<App />, document.getElementById('app')!);
