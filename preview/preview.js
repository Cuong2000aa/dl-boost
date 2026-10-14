const files = [
  {
    name: "ubuntu-24.04-desktop.iso",
    pct: 62,
    speed: "8.1 MB/s",
    status: "Đang tải",
    parts: [100, 100, 80, 45, 20, 10, 0, 0],
  },
  {
    name: "design-pack.zip",
    pct: 28,
    speed: "4.3 MB/s",
    status: "Đang tải",
    parts: [100, 40, 15, 0],
  },
  {
    name: "lecture-03.pdf",
    pct: 0,
    speed: "—",
    status: "Lên lịch 18:00",
    parts: [],
  },
  {
    name: "trailer-4k.mp4",
    pct: 100,
    speed: "—",
    status: "Hoàn tất",
    parts: [100, 100, 100, 100],
  },
];

const rows = document.getElementById("rows");
const liveSpeed = document.getElementById("liveSpeed");

function render() {
  rows.innerHTML = files
    .map((f) => {
      const parts =
        f.parts?.length > 0
          ? `<div class="mini-parts">${f.parts
              .map((p) => `<i style="--w:${p}%"></i>`)
              .join("")}</div>`
          : `<div class="bar"><i style="width:${f.pct}%"></i></div>`;
      return `
    <div class="row">
      <div>
        <strong>${f.name}</strong>
        <span>${f.status}</span>
        ${parts}
      </div>
      <div><span>${f.pct}%</span></div>
      <div><span>${f.speed}</span></div>
    </div>`;
    })
    .join("");
}

render();

setInterval(() => {
  files.forEach((f) => {
    if (f.status !== "Đang tải") return;
    f.pct = Math.min(99, f.pct + Math.random() * 2.2);
    f.speed = `${(3 + Math.random() * 7).toFixed(1)} MB/s`;
    if (f.parts?.length) {
      f.parts = f.parts.map((p, i) =>
        p >= 100 ? 100 : Math.min(100, p + Math.random() * (3 + i))
      );
    }
  });
  const sum = files
    .filter((f) => f.status === "Đang tải")
    .reduce((s, f) => s + parseFloat(f.speed), 0);
  liveSpeed.textContent = `${sum.toFixed(1)} MB/s`;
  render();
}, 900);
