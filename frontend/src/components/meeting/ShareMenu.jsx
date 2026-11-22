import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Share2, Check, Users, Loader2, MonitorPlay } from 'lucide-react';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useToast } from '../../contexts/ToastContext';
import Button from '../ui/Button';

/**
 * Bring other participants into Arlo: invite them to open the app, or start
 * collaborate mode so it opens for everyone. `canCollaborate` is false for
 * guests and outside Zoom.
 */
export default function ShareMenu({ canCollaborate = false }) {
  const { zoomSdk } = useZoomSdk();
  const { addToast } = useToast();
  const [open, setOpen] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [isCollaborating, setIsCollaborating] = useState(false);
  const [collaborateLoading, setCollaborateLoading] = useState(false);
  const containerRef = useRef(null);

  const flashSent = useCallback(() => {
    setInviteSent(true);
    setTimeout(() => setInviteSent(false), 3000);
  }, []);

  const inviteAll = useCallback(async () => {
    if (!zoomSdk?.sendAppInvitationToAllParticipants) return;
    try {
      await zoomSdk.sendAppInvitationToAllParticipants();
      flashSent();
      setOpen(false);
      addToast('Invitation sent to all participants', 'success');
    } catch (err) {
      console.error('sendAppInvitationToAllParticipants failed:', err?.message);
      addToast('Failed to send invitation', 'error');
    }
  }, [zoomSdk, addToast, flashSent]);

  const inviteChoose = useCallback(() => {
    if (!zoomSdk?.showAppInvitationDialog) return;
    zoomSdk.showAppInvitationDialog().catch((err) => {
      console.error('showAppInvitationDialog failed:', err?.message);
    });
    setOpen(false);
  }, [zoomSdk]);

  const toggleCollaborate = useCallback(async () => {
    if (!zoomSdk) return;
    setCollaborateLoading(true);
    try {
      if (isCollaborating) {
        await zoomSdk.endCollaborate();
        setIsCollaborating(false);
        addToast('Collaborate mode ended', 'info');
      } else {
        // Open the app for everyone without sharing the screen
        await zoomSdk.startCollaborate({ shareScreen: false });
        setIsCollaborating(true);
        addToast('Collaborate mode started - all participants can now see Arlo', 'success');
      }
    } catch (err) {
      console.error('Collaborate mode error:', err?.message);
      const errMsg = err?.message || '';
      if (errMsg.includes('app_not_support') || errMsg.includes('80004')) {
        // Known limits: meeting type without collaborate, or not host/co-host
        addToast('Collaborate mode is not available for this meeting', 'info');
      } else if (errMsg.includes('not a function') || errMsg.includes('undefined')) {
        // Older clients without startCollaborate
        try {
          await zoomSdk.runRenderingContext({ view: 'immersive' });
          setIsCollaborating(true);
          addToast('Collaborate mode started', 'success');
        } catch (fallbackErr) {
          console.error('Fallback collaborate error:', fallbackErr?.message);
          addToast('Collaborate mode not available', 'info');
        }
      } else {
        addToast('Collaborate mode not available', 'info');
      }
    } finally {
      setCollaborateLoading(false);
      setOpen(false);
    }
  }, [zoomSdk, isCollaborating, addToast]);

  // Close on click outside
  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Zoom confirms an invitation sent from its own dialog
  useEffect(() => {
    if (!zoomSdk?.onSendAppInvitation) return;
    zoomSdk.onSendAppInvitation(flashSent);
  }, [zoomSdk, flashSent]);

  return (
    <div className="invite-dropdown-container" ref={containerRef}>
      <Button
        variant="outline"
        size="sm"
        className={inviteSent ? 'invite-sent' : ''}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Share Arlo with participants"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {inviteSent ? <Check size={14} aria-hidden="true" /> : <Share2 size={14} aria-hidden="true" />}
      </Button>
      {open && (
        <div className="invite-dropdown" role="menu">
          <button className="invite-dropdown-item" role="menuitem" onClick={inviteAll}>
            <Users size={14} />
            Invite all participants
          </button>
          <button className="invite-dropdown-item" role="menuitem" onClick={inviteChoose}>
            <Share2 size={14} />
            Choose participants...
          </button>
          {canCollaborate && (
            <button className="invite-dropdown-item" role="menuitem" onClick={toggleCollaborate} disabled={collaborateLoading}>
              {collaborateLoading ? <Loader2 size={14} className="animate-spin" /> : <MonitorPlay size={14} />}
              {isCollaborating ? 'End collaborate mode' : 'Start collaborate mode'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
