import { SkeletonList } from '@/components/obsiddy/ui/skeleton';

export default function Loading() {
  return <SkeletonList rows={3} label="Loading your settings" />;
}
