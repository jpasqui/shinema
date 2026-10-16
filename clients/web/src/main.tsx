import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {AppearanceProvider} from './Appearance.tsx';
import '../../../packages/design-tokens/tokens.css';
import './styles.css';
import './marquee.css';
import './skins.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppearanceProvider><App/></AppearanceProvider></React.StrictMode>);
