import React, { useState, useEffect, useRef } from 'react';

function GlobalStyles() {
    return (
        <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      body { font-family: 'Inter', sans-serif; background-color: #f3f4f6; }
      #lead-list-container, #call-log { scrollbar-width: thin; scrollbar-color: #9ca3af #e5e7eb; }
    `}</style>
    );
}

export default function SingleFileComponent() {
    const [leads, setLeads] = useState([]);
    const [leadCsv, setLeadCsv] = useState(
        //         `Example: John Doe,Acme Inc,VP of Engineering,+1555123456
        // Jane Smith,Beta Corp,CTO,+1555789012`
        'John Doe,Acme Inc,VP of Engineering,+972533364168'
    );
    const [currentLeadId, setCurrentLeadId] = useState(null);
    const [isDialing, setIsDialing] = useState(false);
    const [isCallActive, setIsCallActive] = useState(false);
    const [callLog, setCallLog] = useState([]);
    const [agentStatus, setAgentStatus] = useState('Offline');
    const [allCallsEnded, setAllCallsEnded] = useState(false);

    const callTimeoutRef = useRef(null);
    const prevLeadsRef = useRef([]);

    useEffect(() => {
        return () => {
            if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
        };
    }, []);

    const handleLoadLeads = () => {
        const csvText = (leadCsv || '').trim();
        if (!csvText) return;
        const parsed = csvText.split('\n').map((row, i) => {
            const [name, company, title, phone] = row.split(',');
            return {
                id: i,
                name: name?.trim() || 'Unknown',
                company: company?.trim() || 'Unknown',
                title: title?.trim() || 'Unknown',
                phone: phone?.trim() || 'Unknown',
                status: 'Pending',
                notes: '',
                label: null // null, 'scheduled', 'hangup', or 'irrelevant'
            };
        });
        setLeads(parsed);
    };

    const handleToggleDialer = () => {
        if (isDialing) {
            setIsDialing(false);
            if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
            setAgentStatus('Offline');
        } else {
            setIsDialing(true);
            callNextLead();
        }
    };

    const callNextLead = () => {
        const next = leads.find(l => l.status === 'Pending');
        if (!next) { setIsDialing(false); return; }
        setCurrentLeadId(next.id);
        setLeads(prev => prev.map(p => p.id === next.id ? { ...p, status: 'Dialing...' } : p));
        startCall(next);
    };

    const startCall = (lead) => {
        setAgentStatus('Dialing');
        setIsCallActive(true);
        setAllCallsEnded(false);
        setCallLog(prev => [...prev, `Calling ${lead.name} at ${lead.phone}`]);

        fetch('/start-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: lead.name, phone: lead.phone, leadId: lead.id })
        }).then(async (resp) => {
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to start call');
            }
            const data = await resp.json();
            setAgentStatus('Ringing');
            setLeads(prev => prev.map(p => p.id === lead.id ? { ...p, status: 'Ringing', callSid: data.callSid } : p));
            // After Twilio answers, the live websocket media stream will drive AI/TTS on the server.
        }).catch((err) => {
            console.error('Start call error', err);
            setStatusMessage(String(err.message || err));
            setAgentStatus('Offline');
            setIsCallActive(false);
            setLeads(prev => prev.map(p => p.id === lead.id ? { ...p, status: 'Call Failed', notes: String(err.message || err) } : p));
            // Continue dialing next lead if auto-dialer was active
            if (isDialing) callTimeoutRef.current = setTimeout(callNextLead, 2500);
        });
    };

    // Poll call statuses from server when we have active callSids
    useEffect(() => {
        let timer = null;
        const shouldPoll = leads.some(l => l.callSid && !['Called', 'Call Failed', 'Failed', 'No Answer', 'Busy', '📅', '📞', '❌'].some(term => l.status.includes(term)));
        if (shouldPoll) {
            const poll = async () => {
                try {
                    const resp = await fetch('/calls-status', { cache: 'no-store' });
                    if (!resp.ok) return;
                    const data = await resp.json();

                    // Build updated leads array from current state (prev) so we can detect transitions
                    setLeads(prev => {
                        const updated = prev.map(l => {
                            if (!l.callSid) return l;
                            const entry = data.find(d => d.sid === l.callSid);
                            if (!entry) return l;

                            let status = entry.status || l.status;
                            // human friendly labels
                            if (status === 'in-progress') status = 'In Call';
                            if (status === 'completed') status = 'Called';
                            if (status === 'no-answer') status = 'No Answer';
                            if (status === 'busy') status = 'Busy';
                            if (status === 'failed') status = 'Failed';
                            if (status === 'ringing') status = 'Ringing';

                            // Automatically detect outcome from backend
                            let label = l.label;
                            if (entry.outcome && entry.outcome.type) {
                                label = entry.outcome.type;
                                if (entry.outcome.type === 'scheduled' && entry.outcome.details) {
                                    status = `📅 ${entry.outcome.details}`;
                                } else if (entry.outcome.type === 'hangup') {
                                    status = '📞 Hung Up';
                                } else if (entry.outcome.type === 'irrelevant') {
                                    status = '❌ Not Relevant';
                                }
                            }

                            return { ...l, status, label };
                        });

                        // detect transitions from prev -> updated: if current lead got a label newly, advance
                        try {
                            const prevLeads = prevLeadsRef.current || prev;
                            for (let i = 0; i < updated.length; i++) {
                                const p = prevLeads[i];
                                const u = updated[i];
                                if (!p || !u) continue;
                                const previouslyLabel = p.label;
                                const nowLabel = u.label;
                                // If label transitioned from falsy -> truthy on the current lead, advance
                                if ((!previouslyLabel) && nowLabel && isDialing && u.id === currentLeadId) {
                                    console.log('Auto-advance: detected label on current lead, scheduling next...');
                                    if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
                                    setTimeout(() => {
                                        // clear call active state then advance
                                        setIsCallActive(false);
                                        setCurrentLeadId(null);
                                        callNextLead();
                                    }, 1500);
                                    break;
                                }
                            }
                        } catch (e) { }

                        // store for next poll
                        prevLeadsRef.current = updated.map(l => ({ id: l.id, label: l.label }));

                        return updated;
                    });

                    // If no active (non-terminal) calls remain, notify and stop dialer
                    const activeCalls = data.filter(d => !['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(d.status));
                    if (activeCalls.length === 0 && leads.some(l => l.callSid)) {
                        setStatusMessage('All calls ended');
                        setIsDialing(false);
                        setAgentStatus('Offline');
                        setAllCallsEnded(true);
                        try {
                            if (window && window.Notification) {
                                if (Notification.permission === 'granted') new Notification('All calls ended');
                                else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => { if (p === 'granted') new Notification('All calls ended'); });
                            }
                        } catch (e) { }
                    }
                } catch (err) {
                    // ignore polling errors for now
                }
            }

            poll();
            timer = setInterval(poll, 2000);
        }
        return () => { if (timer) clearInterval(timer); };
    }, [leads, isDialing, currentLeadId]);

    const endCall = () => {
        setIsCallActive(false);
        setAgentStatus('Offline');
        setCurrentLeadId(null);
        if (isDialing) callTimeoutRef.current = setTimeout(callNextLead, 2500);
    };

    return (
        <>
            <GlobalStyles />
            <div style={{ padding: 20 }}>
                <h1>Auto-sells Call Scheduler</h1>
                <div style={{ display: 'flex', gap: 20, marginTop: 20 }}>
                    <div style={{ flex: 1 }}>
                        <h2>Leads</h2>
                        <textarea rows={6} value={leadCsv} onChange={e => setLeadCsv(e.target.value)} style={{ width: '100%' }} />
                        <button onClick={handleLoadLeads} style={{ marginTop: 8 }}>Load Leads</button>
                        <div id="lead-list-container" style={{ marginTop: 12 }}>
                            {leads.map(l => (
                                <div key={l.id} style={{ padding: 8, border: '1px solid #ddd', marginBottom: 8, background: l.label === 'scheduled' ? '#d1fae5' : l.label === 'hangup' ? '#fee2e2' : l.label === 'irrelevant' ? '#e5e7eb' : '#fff' }}>
                                    <div><strong>{l.name}</strong> <span style={{ float: 'right' }}>{l.status}</span></div>
                                    <div style={{ fontSize: 12, color: '#666' }}>{l.title} at {l.company}</div>
                                    <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{l.phone}</div>
                                </div>
                            ))}
                        </div>
                        <button onClick={handleToggleDialer} style={{ width: '100%', marginTop: 8 }}>{isDialing ? 'Stop Dialing' : 'Start Dialing'}</button>
                    </div>

                    <div style={{ flex: 1 }}>
                        <h2>Call Log</h2>
                        <div style={{ background: '#111', color: '#fff', padding: 12, borderRadius: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ fontWeight: 600 }}>Status: {agentStatus}</div>
                                <div style={{ width: 12, height: 12, borderRadius: 6, background: isCallActive ? '#10b981' : '#6b7280' }} />
                            </div>
                        </div>

                        <div id="call-log" style={{ marginTop: 12, height: 300, overflowY: 'auto', padding: 8, border: '1px solid #eee', background: '#fff' }}>
                            {callLog.map((entry, i) => (
                                <div key={i} style={{ marginBottom: 8, fontSize: 14 }}>
                                    {entry}
                                </div>
                            ))}
                        </div>

                        <div style={{ marginTop: 8 }}>
                            <button onClick={endCall} disabled={!isCallActive || allCallsEnded} style={{ width: '100%' }}>End Current Call</button>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
