import { SkeletonList } from '@/components/resparkable/ui/skeleton';

export default function Loading() {
  return <SkeletonList rows={3} label="Loading your settings" />;
}
