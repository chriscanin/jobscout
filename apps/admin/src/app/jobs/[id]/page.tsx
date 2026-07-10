export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  void params;
  return (
    <div>
      <h1>Job Detail</h1>
      <p>wave 4</p>
    </div>
  );
}
