import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "@/pages/Home";
import ThanosCommandCenter, { ThanosSuperadmin } from "@/pages/ThanosCommandCenter";
import PastoralChat from "./pages/PastoralChat";
import Settings from "./pages/Settings";

function ThanosCommandCenterRoute() {
  return <ThanosCommandCenter />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={ThanosCommandCenterRoute} />
      <Route path="/assistente" component={ThanosCommandCenterRoute} />
      <Route path="/superadmin" component={ThanosSuperadmin} />
      <Route path="/pastoral" component={Home} />
      <Route path="/assistente-pastoral" component={PastoralChat} />
      <Route path="/configuracoes" component={Settings} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider><Toaster /><Router /></TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
