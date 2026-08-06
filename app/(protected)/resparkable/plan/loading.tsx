import { SkeletonList } from '@/components/resparkable/ui/skeleton';

export default function Loading() {
  return <SkeletonList rows={4} label="Loading your day" />;
}
