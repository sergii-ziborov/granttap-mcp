import { controllerPeerGate } from '../pairing/controllers';
import { TaskActivityPublisher, type ActivityPublisherOptions } from './publisher';
export { TaskActivityPublisher } from './publisher';
export { taskActivitySnapshot } from './presentation';
export { activitySubscription } from './subscription';

export function startTaskActivities(options: Omit<ActivityPublisherOptions, 'peerAllowed'>): () => void {
  const publisher = new TaskActivityPublisher({...options, peerAllowed: controllerPeerGate(options.config)});
  const timer = setInterval(() => void publisher.tick(), 15_000);
  timer.unref();
  void publisher.tick();
  return () => { clearInterval(timer); publisher.close(); };
}
