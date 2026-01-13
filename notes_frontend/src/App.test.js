import { render, screen } from '@testing-library/react';
import App from './App';

test('renders app title', () => {
  render(<App />);
  expect(screen.getAllByText(/Simple Notes/i).length).toBeGreaterThan(0);
});
