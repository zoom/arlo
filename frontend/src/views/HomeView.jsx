import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Mic,
  Calendar,
  Clock,
  DollarSign,
  Scale,
  FileText,
  Stethoscope,
  Users,
  TrendingUp,
  Target,
  Phone,
  AlertTriangle,
  CheckCircle,
  Smile,
  Frown,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useMeeting } from '../contexts/MeetingContext';
import { useVertical } from '../contexts/VerticalContext';
import { useServerSettings } from '../contexts/ServerSettingsContext';
import { useDemoData } from '../hooks/useDemoData';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import './HomeView.css';

// =============================================================================
// GENERAL (NOTES) MOCK DATA
// =============================================================================
const mockWeeklyDigest = {
  meetingCount: 7,
  totalTime: '5.2h',
  topTopics: ['Product Strategy', 'Technical Planning', 'Q1 Review'],
  summary: 'This week focused on Q1 planning and product roadmap alignment. Key decisions around mobile app priorities and hiring timeline were finalized.',
};

const mockActionItems = [
  { id: '1', task: 'Finalize mobile design mockups', owner: 'Sarah Chen', meeting: 'Product Strategy Q1 Review', meetingId: '1', done: false, due: 'Feb 15' },
  { id: '2', task: 'Review notification system architecture', owner: 'Marcus Johnson', meeting: 'Technical Planning', meetingId: '2', done: false },
  { id: '3', task: 'Send client proposal draft', owner: 'Elena Rodriguez', meeting: 'Client Check-in', meetingId: '3', done: true },
];

const mockRecurringTopics = ['Q3 Budget', 'Hiring', 'Product Launch', 'Mobile App'];

// =============================================================================
// LEGAL MOCK DATA
// =============================================================================
const mockLegalData = {
  weeklyStats: {
    billableHours: 32.5,
    totalBilled: 14625,
    depositions: 4,
    activeCases: 12,
  },
  recentMatters: [
    { id: '1', name: 'Thompson v. Nexus Technologies', caseNumber: '2025-0342', type: 'Employment', lastActivity: 'Deposition', lastActivityDate: 'Today', billableHours: 8.5 },
    { id: '2', name: 'Riverside Development LLC', caseNumber: '2025-0298', type: 'Real Estate', lastActivity: 'Client Call', lastActivityDate: 'Yesterday', billableHours: 3.2 },
    { id: '3', name: 'Chen Family Trust', caseNumber: '2025-0315', type: 'Estate Planning', lastActivity: 'Document Review', lastActivityDate: 'Mar 25', billableHours: 2.0 },
  ],
  upcomingDepositions: [
    { id: '1', case: 'Thompson v. Nexus', witness: 'CFO Deposition', date: 'Tomorrow, 10:00 AM' },
    { id: '2', case: 'Martinez Class Action', witness: 'Expert Witness', date: 'Mar 30, 2:00 PM' },
  ],
};

// =============================================================================
// HEALTHCARE MOCK DATA
// =============================================================================
const mockHealthcareData = {
  todayStats: {
    patientsToday: 8,
    notesCompleted: 5,
    notesPending: 3,
    avgVisitTime: '24m',
  },
  recentPatients: [
    { id: '1', name: 'Robert Martinez', mrn: 'MRN-78234', visitType: 'Follow-up', status: 'Notes Pending', time: '2:30 PM' },
    { id: '2', name: 'Sarah Thompson', mrn: 'MRN-65891', visitType: 'Annual Physical', status: 'Completed', time: '1:00 PM' },
    { id: '3', name: 'James Wilson', mrn: 'MRN-43221', visitType: 'New Patient', status: 'Completed', time: '11:30 AM' },
  ],
  clinicalAlerts: [
    { id: '1', patient: 'Robert Martinez', alert: 'Drug interaction flagged', severity: 'high' },
    { id: '2', patient: 'Emily Chen', alert: 'Lab results require review', severity: 'medium' },
  ],
};

// =============================================================================
// SALES MOCK DATA
// =============================================================================
const mockSalesData = {
  pipelineStats: {
    totalPipeline: 2450000,
    dealsInProgress: 18,
    closingThisMonth: 5,
    winRate: 34,
  },
  recentDeals: [
    { id: '1', company: 'Acme Corporation', value: 450000, stage: 'Negotiation', nextStep: 'Contract review', owner: 'You', probability: 75 },
    { id: '2', company: 'TechStart Inc', value: 125000, stage: 'Demo Scheduled', nextStep: 'Product demo tomorrow', owner: 'You', probability: 40 },
    { id: '3', company: 'Global Logistics', value: 280000, stage: 'Proposal Sent', nextStep: 'Follow-up call', owner: 'You', probability: 50 },
  ],
  recentCalls: [
    { id: '1', company: 'Acme Corporation', type: 'Discovery', outcome: 'Positive', date: 'Today' },
    { id: '2', company: 'BlueSky Ventures', type: 'Follow-up', outcome: 'Needs Info', date: 'Yesterday' },
  ],
};

// =============================================================================
// SUPPORT MOCK DATA
// =============================================================================
const mockSupportData = {
  todayStats: {
    callsHandled: 23,
    avgHandleTime: '8m 32s',
    csat: 4.6,
    escalations: 2,
  },
  recentCalls: [
    { id: '1', customer: 'Tech Solutions Ltd', issue: 'Billing inquiry', sentiment: 'positive', resolution: 'Resolved', duration: '6:45' },
    { id: '2', customer: 'Amanda Peters', issue: 'Product return', sentiment: 'neutral', resolution: 'Resolved', duration: '12:30' },
    { id: '3', customer: 'DataFlow Inc', issue: 'Technical support', sentiment: 'negative', resolution: 'Escalated', duration: '18:22' },
  ],
  escalationQueue: [
    { id: '1', customer: 'DataFlow Inc', issue: 'API integration failure', priority: 'High', waitTime: '45m' },
    { id: '2', customer: 'James Morrison', issue: 'Account access', priority: 'Medium', waitTime: '2h' },
  ],
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export default function HomeView() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { meetingId, rtmsActive } = useMeeting();
  const { verticalId, vertical } = useVertical();
  const { showMeetingHistory } = useServerSettings();
  const { showDemoData } = useDemoData();
  const [highlights, setHighlights] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [upcomingMeetings, setUpcomingMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionItems, setActionItems] = useState(mockActionItems);

  useEffect(() => {
    async function fetchHomeData() {
      try {
        const [highlightsRes, remindersRes, upcomingRes] = await Promise.allSettled([
          fetch('/api/home/highlights', { credentials: 'include' }),
          fetch('/api/home/reminders', { credentials: 'include' }),
          fetch('/api/zoom-meetings', { credentials: 'include' }),
        ]);

        if (highlightsRes.status === 'fulfilled' && highlightsRes.value.ok) {
          const data = await highlightsRes.value.json();
          setHighlights(data.highlights || []);
        }

        if (remindersRes.status === 'fulfilled' && remindersRes.value.ok) {
          const data = await remindersRes.value.json();
          setReminders(data.reminders || []);
        }

        if (upcomingRes.status === 'fulfilled' && upcomingRes.value.ok) {
          const data = await upcomingRes.value.json();
          setUpcomingMeetings((data.meetings || []).slice(0, 3));
        }
      } catch {
        // Fetch failed — keep empty defaults
      } finally {
        setLoading(false);
      }
    }
    fetchHomeData();
  }, []);

  const handleGoToMeeting = () => {
    if (meetingId) {
      navigate(`/meeting/${encodeURIComponent(meetingId)}`);
    }
  };

  const toggleUpcomingAutoOpen = useCallback(async (id) => {
    const meeting = upcomingMeetings.find((m) => m.id === id);
    if (!meeting) return;
    const wasEnabled = meeting.autoOpenEnabled;
    setUpcomingMeetings((prev) =>
      prev.map((m) => (m.id === id ? { ...m, autoOpenEnabled: !m.autoOpenEnabled } : m))
    );
    try {
      await fetch(`/api/zoom-meetings/${id}/auto-open`, {
        method: wasEnabled ? 'DELETE' : 'POST',
        credentials: 'include',
      });
    } catch {
      // keep optimistic state in mock mode
    }
  }, [upcomingMeetings]);

  const formatUpcomingTime = (dateStr, duration) => {
    const date = new Date(dateStr);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const startTime = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const endDate = new Date(date.getTime() + duration * 60000);
    const endTime = endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${dayName}, ${monthDay} · ${startTime} – ${endTime}`;
  };

  const toggleActionItem = (id) => {
    setActionItems(items =>
      items.map(item =>
        item.id === id ? { ...item, done: !item.done } : item
      )
    );
  };

  if (loading) {
    return (
      <div className="home-loading">
        <LoadingSpinner />
      </div>
    );
  }

  const hasContent = highlights.length > 0 || reminders.length > 0;
  const showMeetingInProgress = meetingId && !rtmsActive;
  const firstName = user?.displayName?.split(' ')[0];

  // Render vertical-specific dashboard
  const renderVerticalDashboard = () => {
    switch (verticalId) {
      case 'legal':
        return <LegalDashboard data={showDemoData ? mockLegalData : null} navigate={navigate} />;
      case 'healthcare':
        return <HealthcareDashboard data={showDemoData ? mockHealthcareData : null} navigate={navigate} />;
      case 'sales':
        return <SalesDashboard data={showDemoData ? mockSalesData : null} navigate={navigate} />;
      case 'support':
        return <SupportDashboard data={showDemoData ? mockSupportData : null} navigate={navigate} />;
      default:
        return (
          <GeneralDashboard
            hasContent={hasContent}
            highlights={highlights}
            reminders={reminders}
            actionItems={showDemoData ? actionItems : []}
            toggleActionItem={toggleActionItem}
            navigate={navigate}
            showDemoData={showDemoData}
          />
        );
    }
  };

  return (
    <div className="home-view">
      <div className="home-greeting">
        <h1 className="text-serif text-2xl">
          {firstName ? `Hi, ${firstName}` : 'Welcome'}
        </h1>
        {vertical && (
          <p className="text-muted text-sm home-vertical-label">
            {vertical.name}
          </p>
        )}
      </div>

      {showMeetingInProgress && (
        <Card className="home-meeting-card" onClick={handleGoToMeeting} style={{ cursor: 'pointer' }}>
          <div className="home-meeting-inner">
            <div className="home-meeting-text">
              <h2 className="text-serif">Meeting in Progress</h2>
              <p className="text-sans text-sm text-muted">
                Tap to view your meeting
              </p>
            </div>
            <Button
              size="lg"
              onClick={handleGoToMeeting}
              className="home-start-btn"
            >
              <Mic size={16} />
              View Meeting
            </Button>
          </div>
        </Card>
      )}

      {/* Upcoming Meetings - shown for all verticals */}
      {upcomingMeetings.length > 0 && (
        <section className="home-section">
          <div className="home-upcoming-header">
            <h2 className="text-serif home-section-title">Upcoming meetings</h2>
            <button
              onClick={() => navigate('/upcoming')}
              className="text-sans home-upcoming-view-all"
            >
              View all
            </button>
          </div>
          <div className="home-cards">
            {upcomingMeetings.map((meeting) => (
              <Card key={meeting.id} className="home-upcoming-card">
                <div className="home-upcoming-card-inner">
                  <div className="home-upcoming-card-content">
                    <div className="home-upcoming-title-row">
                      <p className="text-serif text-sm font-medium home-upcoming-title">
                        {meeting.title}
                      </p>
                      {meeting.autoOpenEnabled && (
                        <Badge className="home-upcoming-badge">Auto-open</Badge>
                      )}
                    </div>
                    <p className="text-sans text-xs text-muted">
                      {formatUpcomingTime(meeting.date, meeting.duration)}
                    </p>
                  </div>
                  <div className="home-upcoming-toggle-col">
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={meeting.autoOpenEnabled}
                        onChange={() => toggleUpcomingAutoOpen(meeting.id)}
                      />
                      <span className="settings-toggle-track" />
                      <span className="settings-toggle-thumb" />
                    </label>
                    <span className="text-sans home-upcoming-toggle-label">Auto-open</span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Vertical-specific content */}
      {renderVerticalDashboard()}

      {showMeetingHistory && (
        <Button
          variant="outline"
          onClick={() => navigate('/meetings')}
          className="home-view-all-btn"
        >
          View all meetings
        </Button>
      )}
    </div>
  );
}

// =============================================================================
// LEGAL DASHBOARD
// =============================================================================
function LegalDashboard({ data, navigate }) {
  if (!data) {
    return (
      <div className="home-empty">
        <Scale size={32} className="text-muted" style={{ opacity: 0.5 }} />
        <p className="text-serif text-muted">No legal data yet.</p>
        <p className="text-muted text-sm">Start a meeting with Arlo to track billable hours and matters.</p>
      </div>
    );
  }

  return (
    <>
      {/* Billable Hours Stats */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">This week's billing</h2>
        <Card>
          <div className="home-stats-grid">
            <div className="home-stat-item">
              <Clock size={20} className="home-stat-icon legal" />
              <div className="home-stat-number">{data.weeklyStats.billableHours}h</div>
              <div className="home-stat-label">Billable Hours</div>
            </div>
            <div className="home-stat-item">
              <DollarSign size={20} className="home-stat-icon legal" />
              <div className="home-stat-number">${data.weeklyStats.totalBilled.toLocaleString()}</div>
              <div className="home-stat-label">Total Billed</div>
            </div>
            <div className="home-stat-item">
              <Scale size={20} className="home-stat-icon legal" />
              <div className="home-stat-number">{data.weeklyStats.depositions}</div>
              <div className="home-stat-label">Depositions</div>
            </div>
            <div className="home-stat-item">
              <FileText size={20} className="home-stat-icon legal" />
              <div className="home-stat-number">{data.weeklyStats.activeCases}</div>
              <div className="home-stat-label">Active Cases</div>
            </div>
          </div>
        </Card>
      </section>

      {/* Recent Matters */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Recent matters</h2>
        <div className="home-cards">
          {data.recentMatters.map((matter) => (
            <Card key={matter.id} className="home-matter-card">
              <div className="home-matter-inner">
                <div className="home-matter-header">
                  <div className="home-matter-title">
                    <p className="text-serif text-sm font-medium">{matter.name}</p>
                    <p className="text-sans text-xs text-muted">{matter.caseNumber} · {matter.type}</p>
                  </div>
                  <Badge variant="outline">{matter.billableHours}h</Badge>
                </div>
                <div className="home-matter-meta">
                  <span>{matter.lastActivity}</span>
                  <span>·</span>
                  <span>{matter.lastActivityDate}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Upcoming Depositions */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Upcoming depositions</h2>
        <div className="home-cards">
          {data.upcomingDepositions.map((depo) => (
            <Card key={depo.id}>
              <div className="home-depo-card">
                <Scale size={18} className="home-depo-icon" />
                <div className="home-depo-content">
                  <p className="text-serif text-sm font-medium">{depo.witness}</p>
                  <p className="text-sans text-xs text-muted">{depo.case} · {depo.date}</p>
                </div>
                <ChevronRight size={18} className="text-muted" />
              </div>
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}

// =============================================================================
// HEALTHCARE DASHBOARD
// =============================================================================
function HealthcareDashboard({ data, navigate }) {
  if (!data) {
    return (
      <div className="home-empty">
        <Stethoscope size={32} className="text-muted" style={{ opacity: 0.5 }} />
        <p className="text-serif text-muted">No patient data yet.</p>
        <p className="text-muted text-sm">Start a patient visit with Arlo to see clinical documentation here.</p>
      </div>
    );
  }

  return (
    <>
      {/* Today's Stats */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Today's schedule</h2>
        <Card>
          <div className="home-stats-grid">
            <div className="home-stat-item">
              <Users size={20} className="home-stat-icon healthcare" />
              <div className="home-stat-number">{data.todayStats.patientsToday}</div>
              <div className="home-stat-label">Patients</div>
            </div>
            <div className="home-stat-item">
              <CheckCircle size={20} className="home-stat-icon healthcare" />
              <div className="home-stat-number">{data.todayStats.notesCompleted}</div>
              <div className="home-stat-label">Notes Done</div>
            </div>
            <div className="home-stat-item">
              <FileText size={20} className="home-stat-icon healthcare" />
              <div className="home-stat-number">{data.todayStats.notesPending}</div>
              <div className="home-stat-label">Pending</div>
            </div>
            <div className="home-stat-item">
              <Clock size={20} className="home-stat-icon healthcare" />
              <div className="home-stat-number">{data.todayStats.avgVisitTime}</div>
              <div className="home-stat-label">Avg Visit</div>
            </div>
          </div>
        </Card>
      </section>

      {/* Clinical Alerts */}
      {data.clinicalAlerts.length > 0 && (
        <section className="home-section">
          <h2 className="text-serif home-section-title">Clinical alerts</h2>
          <div className="home-cards">
            {data.clinicalAlerts.map((alert) => (
              <Card key={alert.id} className={`home-alert-card ${alert.severity}`}>
                <div className="home-alert-inner">
                  <AlertTriangle size={18} className="home-alert-icon" />
                  <div className="home-alert-content">
                    <p className="text-serif text-sm font-medium">{alert.patient}</p>
                    <p className="text-sans text-xs">{alert.alert}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Recent Patients */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Recent patients</h2>
        <div className="home-cards">
          {data.recentPatients.map((patient) => (
            <Card key={patient.id}>
              <div className="home-patient-card">
                <Stethoscope size={18} className="home-patient-icon" />
                <div className="home-patient-content">
                  <div className="home-patient-header">
                    <p className="text-serif text-sm font-medium">{patient.name}</p>
                    <Badge variant={patient.status === 'Completed' ? 'default' : 'outline'}>
                      {patient.status}
                    </Badge>
                  </div>
                  <p className="text-sans text-xs text-muted">
                    {patient.mrn} · {patient.visitType} · {patient.time}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}

// =============================================================================
// SALES DASHBOARD
// =============================================================================
function SalesDashboard({ data, navigate }) {
  if (!data) {
    return (
      <div className="home-empty">
        <TrendingUp size={32} className="text-muted" style={{ opacity: 0.5 }} />
        <p className="text-serif text-muted">No sales data yet.</p>
        <p className="text-muted text-sm">Start a sales call with Arlo to track deals and commitments.</p>
      </div>
    );
  }

  return (
    <>
      {/* Pipeline Stats */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Pipeline overview</h2>
        <Card>
          <div className="home-stats-grid">
            <div className="home-stat-item">
              <DollarSign size={20} className="home-stat-icon sales" />
              <div className="home-stat-number">${(data.pipelineStats.totalPipeline / 1000000).toFixed(1)}M</div>
              <div className="home-stat-label">Pipeline</div>
            </div>
            <div className="home-stat-item">
              <Target size={20} className="home-stat-icon sales" />
              <div className="home-stat-number">{data.pipelineStats.dealsInProgress}</div>
              <div className="home-stat-label">Active Deals</div>
            </div>
            <div className="home-stat-item">
              <Calendar size={20} className="home-stat-icon sales" />
              <div className="home-stat-number">{data.pipelineStats.closingThisMonth}</div>
              <div className="home-stat-label">Closing Soon</div>
            </div>
            <div className="home-stat-item">
              <TrendingUp size={20} className="home-stat-icon sales" />
              <div className="home-stat-number">{data.pipelineStats.winRate}%</div>
              <div className="home-stat-label">Win Rate</div>
            </div>
          </div>
        </Card>
      </section>

      {/* Active Deals */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Active deals</h2>
        <div className="home-cards">
          {data.recentDeals.map((deal) => (
            <Card key={deal.id}>
              <div className="home-deal-card">
                <div className="home-deal-header">
                  <div>
                    <p className="text-serif text-sm font-medium">{deal.company}</p>
                    <p className="text-sans text-xs text-muted">{deal.stage}</p>
                  </div>
                  <div className="home-deal-value">
                    <span className="text-serif font-medium">${(deal.value / 1000).toFixed(0)}K</span>
                    <Badge variant="outline">{deal.probability}%</Badge>
                  </div>
                </div>
                <div className="home-deal-next">
                  <span className="text-sans text-xs">Next:</span>
                  <span className="text-sans text-xs text-muted">{deal.nextStep}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Recent Calls */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Recent calls</h2>
        <div className="home-cards">
          {data.recentCalls.map((call) => (
            <Card key={call.id}>
              <div className="home-call-card">
                <Phone size={18} className="home-call-icon" />
                <div className="home-call-content">
                  <p className="text-serif text-sm font-medium">{call.company}</p>
                  <p className="text-sans text-xs text-muted">{call.type} · {call.date}</p>
                </div>
                <Badge variant={call.outcome === 'Positive' ? 'default' : 'outline'}>
                  {call.outcome}
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}

// =============================================================================
// SUPPORT DASHBOARD
// =============================================================================
function SupportDashboard({ data, navigate }) {
  const getSentimentIcon = (sentiment) => {
    switch (sentiment) {
      case 'positive': return <Smile size={16} className="sentiment-positive" />;
      case 'negative': return <Frown size={16} className="sentiment-negative" />;
      default: return null;
    }
  };

  if (!data) {
    return (
      <div className="home-empty">
        <Phone size={32} className="text-muted" style={{ opacity: 0.5 }} />
        <p className="text-serif text-muted">No support data yet.</p>
        <p className="text-muted text-sm">Start a support call with Arlo to track sentiment and resolutions.</p>
      </div>
    );
  }

  return (
    <>
      {/* Today's Stats */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Today's performance</h2>
        <Card>
          <div className="home-stats-grid">
            <div className="home-stat-item">
              <Phone size={20} className="home-stat-icon support" />
              <div className="home-stat-number">{data.todayStats.callsHandled}</div>
              <div className="home-stat-label">Calls</div>
            </div>
            <div className="home-stat-item">
              <Clock size={20} className="home-stat-icon support" />
              <div className="home-stat-number">{data.todayStats.avgHandleTime}</div>
              <div className="home-stat-label">Avg Handle</div>
            </div>
            <div className="home-stat-item">
              <Smile size={20} className="home-stat-icon support" />
              <div className="home-stat-number">{data.todayStats.csat}</div>
              <div className="home-stat-label">CSAT</div>
            </div>
            <div className="home-stat-item">
              <AlertTriangle size={20} className="home-stat-icon support" />
              <div className="home-stat-number">{data.todayStats.escalations}</div>
              <div className="home-stat-label">Escalations</div>
            </div>
          </div>
        </Card>
      </section>

      {/* Escalation Queue */}
      {data.escalationQueue.length > 0 && (
        <section className="home-section">
          <h2 className="text-serif home-section-title">Escalation queue</h2>
          <div className="home-cards">
            {data.escalationQueue.map((item) => (
              <Card key={item.id} className="home-escalation-card">
                <div className="home-escalation-inner">
                  <AlertTriangle size={18} className="home-escalation-icon" />
                  <div className="home-escalation-content">
                    <p className="text-serif text-sm font-medium">{item.customer}</p>
                    <p className="text-sans text-xs text-muted">{item.issue}</p>
                  </div>
                  <div className="home-escalation-meta">
                    <Badge variant={item.priority === 'High' ? 'default' : 'outline'}>{item.priority}</Badge>
                    <span className="text-sans text-xs text-muted">{item.waitTime}</span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Recent Calls */}
      <section className="home-section">
        <h2 className="text-serif home-section-title">Recent calls</h2>
        <div className="home-cards">
          {data.recentCalls.map((call) => (
            <Card key={call.id}>
              <div className="home-support-call-card">
                <div className="home-support-call-header">
                  <div className="home-support-call-title">
                    {getSentimentIcon(call.sentiment)}
                    <p className="text-serif text-sm font-medium">{call.customer}</p>
                  </div>
                  <Badge variant={call.resolution === 'Resolved' ? 'default' : 'outline'}>
                    {call.resolution}
                  </Badge>
                </div>
                <p className="text-sans text-xs text-muted">{call.issue} · {call.duration}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}

// =============================================================================
// GENERAL (NOTES) DASHBOARD
// =============================================================================
function GeneralDashboard({ hasContent, highlights, reminders, actionItems, toggleActionItem, navigate, showDemoData }) {
  const hasRealContent = hasContent || highlights.length > 0 || reminders.length > 0;

  if (!hasRealContent && !showDemoData) {
    return (
      <div className="home-empty">
        <Mic size={32} className="text-muted" style={{ opacity: 0.5 }} />
        <p className="text-serif text-muted">No meetings yet this week.</p>
        <p className="text-muted text-sm">Start a Zoom meeting with Arlo to see highlights here.</p>
      </div>
    );
  }

  return (
    <>
      {/* Weekly Digest - only show with demo data */}
      {showDemoData && (
        <section className="home-section">
          <h2 className="text-serif home-section-title">Your week in review</h2>
          <Card>
            <div className="home-digest-card">
              <div className="home-digest-stats">
                <div>
                  <div className="home-digest-stat-number">{mockWeeklyDigest.meetingCount}</div>
                  <p className="home-digest-stat-label">Meetings</p>
                </div>
                <div>
                  <div className="home-digest-stat-number">{mockWeeklyDigest.totalTime}</div>
                  <p className="home-digest-stat-label">Total time</p>
                </div>
              </div>

              <div>
                <p className="home-topics-label">Top topics</p>
                <div className="home-topics-row">
                  {mockWeeklyDigest.topTopics.map((topic, i) => (
                    <Badge key={i} variant="default">{topic}</Badge>
                  ))}
                </div>
              </div>

              <p className="text-serif text-sm text-muted home-digest-summary">
                {mockWeeklyDigest.summary}
              </p>
            </div>
          </Card>
        </section>
      )}

      {/* Action Items - only show if there are items */}
      {actionItems.length > 0 && (
        <section className="home-section">
          <h2 className="text-serif home-section-title">Action items this week</h2>
          <div className="home-cards">
            {actionItems.filter(item => !item.done).map((item) => (
              <Card key={item.id}>
                <div className="home-action-card">
                  <div className="home-action-item">
                    <input
                      type="checkbox"
                      className="home-action-checkbox"
                      checked={item.done}
                      onChange={() => toggleActionItem(item.id)}
                    />
                    <div className="home-action-content">
                      <p className="text-serif text-sm">{item.task}</p>
                      <div className="home-action-meta">
                        <span>Owner: {item.owner}</span>
                        {item.due && (
                          <>
                            <span>&bull;</span>
                            <span>Due: {item.due}</span>
                          </>
                        )}
                        <span>&bull;</span>
                        <button
                          className="home-action-meeting-link"
                          onClick={() => navigate(`/meetings/${item.meetingId}`)}
                        >
                          {item.meeting}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Recurring Topics - only show with demo data */}
      {showDemoData && (
        <section className="home-section">
          <h2 className="text-serif home-section-title">Recurring topics</h2>
          <Card>
            <div className="home-recurring-inner">
              <p className="text-sans text-xs text-muted">
                Topics mentioned in 2+ meetings this week
              </p>
              <div className="home-recurring-badges">
                {mockRecurringTopics.map((topic, i) => (
                  <Badge key={i} variant="outline" className="home-recurring-badge">
                    {topic}
                  </Badge>
                ))}
              </div>
            </div>
          </Card>
        </section>
      )}

      {/* Existing highlights */}
      {highlights.length > 0 && (
        <section className="home-section">
          <h2 className="text-serif home-section-title">This week's highlights</h2>
          <div className="home-cards">
            {highlights.map((h, i) => (
              <Card key={i} className="home-highlight-card" onClick={() => h.meetingId && navigate(`/meetings/${h.meetingId}`)}>
                <div className="home-card-inner">
                  <h4 className="text-serif font-medium">{h.title}</h4>
                  <p className="text-muted text-sm">{h.snippet}</p>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Existing reminders */}
      {reminders.length > 0 && (
        <section className="home-section">
          <h2 className="text-serif home-section-title">Reminders from yesterday</h2>
          <div className="home-cards">
            {reminders.map((r, i) => (
              <Card key={i} className="home-reminder-card">
                <div className="home-card-inner">
                  <p className="text-serif text-sm">{r.task}</p>
                  {r.owner && <p className="text-muted text-xs">Owner: {r.owner}</p>}
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
