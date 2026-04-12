import { AppScreen } from "./app/AppScreen";
import { useAppTheme } from "./app/theme";

export function App() {
  const { theme, setTheme } = useAppTheme();

  return <AppScreen theme={theme} onThemeChange={setTheme} />;
}
