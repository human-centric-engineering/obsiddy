import { SkeletonList } from '@/components/resparkable/ui/skeleton';

export default function Loading() {
  return <SkeletonList rows={6} label="Loading your archive" />;
}
