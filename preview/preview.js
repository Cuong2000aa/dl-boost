const files = [
  { name: "ubuntu-24.04-desktop.iso", pct: 62, speed: "8.1 MB/s", status: "Đang tải" },
  { name: "design-pack.zip", pct: 28, speed: "4.3 MB/s", status: "Đang tải" },
  { name: "lecture-03.pdf", pct: 0, speed: "—", status: "Chờ" },
  { name: "trailer-4k.mp4", pct: 100, speed: "—", status: "Hoàn tất" },
];

const rows = document.getElementById("rows");
const liveSpeed = document.getElementById("liveSpeed");

function render() {
  rows.innerHTML = files
    .map(
      (f) => `
    <div class="row">
      <div>
        <strong>${f.name}</strong>
        <span>${f.status}</span>
        <div class="bar"><i style="width:${f.pct}%"></i></div>
      </div>
      <div><span>${f.pct}%</span></div>
      <div><span>${f.speed}</span></div>
    </div>`
    )
    .join("");
}

render();

// Gentle live motion for the demo
setInterval(() => {
  files.forEach((f) => {
    if (f.status !== "Đang tải") return;
    f.pct = Math.min(99, f.pct + Math.random() * 2.2);
    f.speed = `${(3 + Math.random() * 7).toFixed(1)} MB/s`;
  });
  const sum = files
    .filter((f) => f.status === "Đang tải")
    .reduce((s, f) => s + parseFloat(f.speed), 0);
  liveSpeed.textContent = `${sum.toFixed(1)} MB/s`;
  render();
}, 900);
