import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { PERMISSIONS } from '@openestate/shared';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/AppShell';
import RequirePermission from './components/RequirePermission';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import UsersPage from './pages/admin/Users';
import UserForm from './pages/admin/UserForm';
import HierarchyPage from './pages/admin/Hierarchy';
import RolesPage from './pages/admin/Roles';
import RoleForm from './pages/admin/RoleForm';
import MastersPage from './pages/admin/Masters';
import CustomFieldsPage from './pages/admin/CustomFields';
import LetterTemplatesPage from './pages/admin/LetterTemplates';
import LeadStagesPage from './pages/admin/LeadStages';
import CompanyConfigPage from './pages/admin/CompanyConfig';
import AuditLogPage from './pages/admin/AuditLog';
import BookingWizard from './pages/postsales/BookingWizard';
import InstallmentSchedule from './pages/postsales/InstallmentSchedule';
import ReceiptEntry from './pages/postsales/ReceiptEntry';
import BookingsPage from './pages/postsales/Bookings';
import ChequeQueue from './pages/postsales/ChequeQueue';
import DuesDashboard from './pages/postsales/DuesDashboard';
import Applicant360 from './pages/postsales/Applicant360';
import ReportsPage from './pages/postsales/Reports';
import BrokersPage from './pages/postsales/Brokers';
import BrokerDetail from './pages/postsales/BrokerDetail';
import PluginsPage from './pages/admin/Plugins';
import PluginDetailPage from './pages/admin/PluginDetail';
import WebhooksPage from './pages/admin/Webhooks';
import LeadApiKeysPage from './pages/admin/LeadApiKeys';
import ProjectsPage from './pages/inventory/Projects';
import ProjectDetailPage from './pages/inventory/ProjectDetail';
import InquiriesPage from './pages/presales/Inquiries';
import InquiryDetailPage from './pages/presales/InquiryDetail';
import DeletedLeadsPage from './pages/presales/DeletedLeads';
import PresalesReportsPage from './pages/presales/Reports';
import TicketsPage from './pages/support/Tickets';
import TicketDetailPage from './pages/support/TicketDetail';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin/users" element={<RequirePermission perm={PERMISSIONS.ADMIN_USER_READ}><UsersPage /></RequirePermission>} />
            <Route path="admin/hierarchy" element={<RequirePermission perm={PERMISSIONS.ADMIN_USER_READ}><HierarchyPage /></RequirePermission>} />
            <Route path="admin/users/:id" element={<RequirePermission perm={PERMISSIONS.ADMIN_USER_READ}><UserForm /></RequirePermission>} />
            <Route path="admin/roles" element={<RequirePermission perm={PERMISSIONS.ADMIN_ROLE_READ}><RolesPage /></RequirePermission>} />
            <Route path="admin/roles/:id" element={<RequirePermission perm={PERMISSIONS.ADMIN_ROLE_READ}><RoleForm /></RequirePermission>} />
            <Route path="admin/masters" element={<RequirePermission perm={PERMISSIONS.ADMIN_MASTER_READ}><MastersPage /></RequirePermission>} />
            <Route path="admin/custom-fields" element={<RequirePermission perm={PERMISSIONS.ADMIN_CUSTOM_FIELD_READ}><CustomFieldsPage /></RequirePermission>} />
            <Route path="admin/letter-templates" element={<RequirePermission perm={PERMISSIONS.ADMIN_MASTER_READ}><LetterTemplatesPage /></RequirePermission>} />
            <Route path="admin/lead-stages" element={<RequirePermission perm={PERMISSIONS.ADMIN_MASTER_READ}><LeadStagesPage /></RequirePermission>} />
            <Route path="admin/config" element={<RequirePermission perm={PERMISSIONS.ADMIN_CONFIG_READ}><CompanyConfigPage /></RequirePermission>} />
            <Route path="admin/audit" element={<RequirePermission perm={PERMISSIONS.ADMIN_AUDIT_READ}><AuditLogPage /></RequirePermission>} />
            <Route path="admin/plugins" element={<RequirePermission perm={PERMISSIONS.ADMIN_PLUGIN_READ}><PluginsPage /></RequirePermission>} />
            <Route path="admin/plugins/:pluginId" element={<RequirePermission perm={PERMISSIONS.ADMIN_PLUGIN_READ}><PluginDetailPage /></RequirePermission>} />
            <Route path="admin/webhooks" element={<RequirePermission perm={PERMISSIONS.ADMIN_WEBHOOK_READ}><WebhooksPage /></RequirePermission>} />
            <Route path="admin/lead-api-keys" element={<RequirePermission perm={PERMISSIONS.ADMIN_LEAD_API_KEY_READ}><LeadApiKeysPage /></RequirePermission>} />

            <Route path="postsales/bookings" element={<RequirePermission perm={PERMISSIONS.POSTSALES_BOOKING_READ}><BookingsPage /></RequirePermission>} />
            <Route path="postsales/bookings/new" element={<RequirePermission perm={PERMISSIONS.POSTSALES_BOOKING_CREATE}><BookingWizard /></RequirePermission>} />
            <Route path="postsales/bookings/:bookingId/installments" element={<RequirePermission perm={PERMISSIONS.POSTSALES_BOOKING_READ}><InstallmentSchedule /></RequirePermission>} />
            <Route path="postsales/receipts/new" element={<RequirePermission perm={PERMISSIONS.POSTSALES_RECEIPT_CREATE}><ReceiptEntry /></RequirePermission>} />
            <Route path="postsales/cheques" element={<RequirePermission perm={PERMISSIONS.POSTSALES_CHEQUE_VERIFY}><ChequeQueue /></RequirePermission>} />
            <Route path="postsales/dues" element={<RequirePermission perm={PERMISSIONS.REPORTS_OUTSTANDING_VIEW}><DuesDashboard /></RequirePermission>} />
            <Route path="postsales/applicants/:applicantId" element={<RequirePermission perm={PERMISSIONS.PRESALES_APPLICANT_READ}><Applicant360 /></RequirePermission>} />
            <Route path="postsales/reports" element={<RequirePermission perm={PERMISSIONS.REPORTS_COLLECTION_VIEW}><ReportsPage /></RequirePermission>} />
            <Route path="postsales/brokers" element={<RequirePermission perm={PERMISSIONS.ADMIN_BROKER_READ}><BrokersPage /></RequirePermission>} />
            <Route path="postsales/brokers/:brokerId" element={<RequirePermission perm={PERMISSIONS.ADMIN_BROKER_READ}><BrokerDetail /></RequirePermission>} />

            <Route path="inventory/projects" element={<RequirePermission perm={PERMISSIONS.INVENTORY_PROJECT_READ}><ProjectsPage /></RequirePermission>} />
            <Route path="inventory/projects/:id" element={<RequirePermission perm={PERMISSIONS.INVENTORY_PROJECT_READ}><ProjectDetailPage /></RequirePermission>} />

            <Route path="presales/inquiries" element={<RequirePermission perm={PERMISSIONS.PRESALES_INQUIRY_READ}><InquiriesPage /></RequirePermission>} />
            <Route path="presales/inquiries/deleted" element={<RequirePermission perm={PERMISSIONS.PRESALES_LEAD_DELETE}><DeletedLeadsPage /></RequirePermission>} />
            <Route path="presales/inquiries/:id" element={<RequirePermission perm={PERMISSIONS.PRESALES_INQUIRY_READ}><InquiryDetailPage /></RequirePermission>} />
            <Route path="presales/reports" element={<RequirePermission perm={PERMISSIONS.PRESALES_REPORT_VIEW}><PresalesReportsPage /></RequirePermission>} />

            <Route path="support/tickets" element={<RequirePermission perm={PERMISSIONS.ADMIN_TICKET_RESPOND}><TicketsPage /></RequirePermission>} />
            <Route path="support/tickets/:id" element={<RequirePermission perm={PERMISSIONS.ADMIN_TICKET_RESPOND}><TicketDetailPage /></RequirePermission>} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
