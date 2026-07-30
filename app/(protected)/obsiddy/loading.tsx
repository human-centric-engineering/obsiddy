import { SkeletonList } from '@/components/obsiddy/ui/skeleton';

export default function Loading() {
  return <SkeletonList rows={6} label="Loading your day" />;
}
