import type { OrderStatus } from '@/lib/orders/lifecycle';

// =============================================================================
// Vendor-Agnostic Customer Communication & Notification Ports
// Zero vendor lock-in: Resend / Postmark / Zendesk / Messenger / WhatsApp
// implement these interfaces later.
// =============================================================================

export interface InboundCustomerMessage {
  channelId: string;
  externalMessageId: string;
  senderHandle: string;
  subject?: string;
  body: string;
  receivedAt: string;
}

export interface OutboundCustomerMessage {
  channelId: string;
  recipientHandle: string;
  subject?: string;
  body: string;
  inReplyToId?: string;
}

export interface CustomerChannelAdapter {
  readonly channelId: string;
  sendMessage(message: OutboundCustomerMessage): Promise<{ externalMessageId: string; sentAt: string }>;
}

export interface CustomerOrderNotification {
  orderNumber: string;
  recipientEmail: string;
  status: OrderStatus;
  trackingNumber?: string;
  trackingUrl?: string;
}

export interface CustomerNotificationAdapter {
  readonly providerId: string;
  sendOrderStatusUpdate(notification: CustomerOrderNotification): Promise<{ deliveryId: string }>;
}
