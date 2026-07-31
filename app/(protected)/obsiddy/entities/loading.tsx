import { SkeletonList } from '@/components/obsiddy/ui/skeleton';

export default function Loading() {
  return <SkeletonList rows={5} label="Loading" />;
}
