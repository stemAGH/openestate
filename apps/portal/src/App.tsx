import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/AppShell';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import InviteConsume from './pages/InviteConsume';
import Profile from './pages/Profile';
import Property from './pages/Property';
import Account from './pages/Account';
import Security from './pages/Security';
import Tickets from './pages/Tickets';
import TicketDetail from './pages/TicketDetail';
import BrokerDashboard from './pages/BrokerDashboard';
import BrokerNocs from './pages/BrokerNocs';
import BrokerStatement from './pages/BrokerStatement';

/** A broker portal session never carries applicantId and vice versa (see
 * AppShell's doc comment) — this just sends each session to its own
 * first tab, same branch AppShell uses for the tab bar itself. */
/** Sends a session to its own home when it opens the other portal role's page (a stale
 * bookmark, a typed address): those pages' data is refused for it anyway. */
function CustomerOnly({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  return user?.brokerId ? <Navigate to="/broker/dashboard" replace /> : children;
}
function BrokerOnly({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  return user?.brokerId ? children : <Navigate to="/profile" replace />;
}

function PortalHome() {
  const { user } = useAuth();
  return <Navigate to={user?.brokerId ? '/broker/dashboard' : '/profile'} replace />;
}

export default function App() {
  return (
    <BrowserRouter basename="/portal">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/invite/:inviteId" element={<InviteConsume />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<PortalHome />} />
            <Route path="profile" element={<CustomerOnly><Profile /></CustomerOnly>} />
            <Route path="property" element={<CustomerOnly><Property /></CustomerOnly>} />
            <Route path="account" element={<CustomerOnly><Account /></CustomerOnly>} />
            <Route path="security" element={<Security />} />
            <Route path="tickets" element={<Tickets />} />
            <Route path="tickets/:id" element={<TicketDetail />} />
            <Route path="broker/dashboard" element={<BrokerOnly><BrokerDashboard /></BrokerOnly>} />
            <Route path="broker/nocs" element={<BrokerOnly><BrokerNocs /></BrokerOnly>} />
            <Route path="broker/statement" element={<BrokerOnly><BrokerStatement /></BrokerOnly>} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
