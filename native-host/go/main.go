// PulseDM Native Host — Windows/macOS binary (no Python required on Windows).
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	hostName = "com.pulsedm.host"
	version  = "1.3.1"
)

var (
	activeCmds sync.Map // jobId -> *exec.Cmd
	cliMode    bool     // CLI download: progress → stderr, không frame native messaging
)

func emitProgress(msg map[string]any) {
	if cliMode {
		if m := strField(msg, "message"); m != "" {
			fmt.Fprintln(os.Stderr, m)
			return
		}
		if pct, ok := msg["percent"].(float64); ok {
			fmt.Fprintf(os.Stderr, "\r%.1f%%   ", pct)
			return
		}
		loaded, _ := msg["loaded"].(int64)
		total, _ := msg["total"].(int64)
		// JSON numbers often decode as float64
		if loaded == 0 {
			if f, ok := msg["loaded"].(float64); ok {
				loaded = int64(f)
			}
		}
		if total == 0 {
			if f, ok := msg["total"].(float64); ok {
				total = int64(f)
			}
		}
		if total > 0 {
			fmt.Fprintf(os.Stderr, "\r%.1f%% (%d / %d)   ", 100*float64(loaded)/float64(total), loaded, total)
		} else if loaded > 0 {
			fmt.Fprintf(os.Stderr, "\r%d bytes   ", loaded)
		}
		return
	}
	_ = sendMessage(msg)
}

var siteRE = regexp.MustCompile(`(?i)(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com)($|\.)`)

func logf(msg string) {
	fmt.Fprintf(os.Stderr, "[pulsedm-host] %s\n", msg)
}

func readMessage() (map[string]any, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(os.Stdin, lenBuf[:]); err != nil {
		return nil, err
	}
	length := binary.LittleEndian.Uint32(lenBuf[:])
	if length == 0 || length > 64*1024*1024 {
		return nil, io.EOF
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(os.Stdin, buf); err != nil {
		return nil, err
	}
	var msg map[string]any
	if err := json.Unmarshal(buf, &msg); err != nil {
		return nil, err
	}
	return msg, nil
}

func sendMessage(msg map[string]any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(data)))
	if _, err := os.Stdout.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = os.Stdout.Write(data)
	return err
}

func whichYtdlp() string {
	names := []string{"yt-dlp", "yt_dlp"}
	if runtime.GOOS == "windows" {
		names = []string{"yt-dlp.exe", "yt-dlp", "yt_dlp.exe", "yt_dlp"}
	}
	for _, name := range names {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		"/opt/homebrew/bin/yt-dlp",
		"/usr/local/bin/yt-dlp",
		filepath.Join(home, ".local/bin/yt-dlp"),
	}
	if runtime.GOOS == "windows" {
		local := os.Getenv("LOCALAPPDATA")
		candidates = append(candidates,
			filepath.Join(home, "AppData/Local/Programs/Python/Python312/Scripts/yt-dlp.exe"),
			filepath.Join(home, "AppData/Local/Programs/Python/Python311/Scripts/yt-dlp.exe"),
			filepath.Join(local, "Programs", "yt-dlp", "yt-dlp.exe"),
			`C:\Windows\yt-dlp.exe`,
		)
	}
	for _, p := range candidates {
		if p == "" {
			continue
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func defaultDownloadDir() string {
	home, _ := os.UserHomeDir()
	var userDL string
	if runtime.GOOS == "windows" {
		profile := os.Getenv("USERPROFILE")
		if profile == "" {
			profile = home
		}
		userDL = filepath.Join(profile, "Downloads", "PulseDM")
	} else {
		userDL = filepath.Join(home, "Downloads", "PulseDM")
	}
	if err := os.MkdirAll(userDL, 0o755); err == nil {
		return userDL
	}
	fallback := filepath.Join(home, "PulseDM-Downloads")
	_ = os.MkdirAll(fallback, 0o755)
	return fallback
}

func statusPayload() map[string]any {
	ytdlp := whichYtdlp()
	var ytdlpVer any
	ytdlpVer = nil
	ready := false
	if ytdlp != "" {
		ready = true
		out, err := exec.Command(ytdlp, "--version").CombinedOutput()
		if err != nil {
			ytdlpVer = "error: " + err.Error()
		} else {
			lines := strings.Split(strings.TrimSpace(string(out)), "\n")
			if len(lines) > 0 {
				ytdlpVer = lines[0]
			}
		}
	}
	ff := whichFfmpeg()
	return map[string]any{
		"type":         "status",
		"ok":           true,
		"hostVersion":  version,
		"hostName":     hostName,
		"runtime":      "go",
		"goos":         runtime.GOOS,
		"ytdlpPath":    nullIfEmpty(ytdlp),
		"ytdlpVersion": ytdlpVer,
		"ytdlpReady":   ready,
		"ffmpegPath":   nullIfEmpty(ff),
		"ffmpegReady":  ff != "",
		"downloadDir":  defaultDownloadDir(),
		"platform":     runtime.GOOS,
	}
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func strField(msg map[string]any, key string) string {
	v, ok := msg[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	default:
		return fmt.Sprint(t)
	}
}

func intField(msg map[string]any, key string, def int) int {
	v, ok := msg[key]
	if !ok || v == nil {
		return def
	}
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case string:
		n, err := strconv.Atoi(t)
		if err == nil {
			return n
		}
	}
	return def
}

func looksLikeSitePage(raw string) bool {
	if strings.Contains(strings.ToLower(raw), ".m3u8") {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return siteRE.MatchString(u.Hostname())
}

func safeName(name string) string {
	re := regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
	name = re.ReplaceAllString(name, "_")
	if name == "" {
		name = fmt.Sprintf("download-%d", time.Now().Unix())
	}
	if len(name) > 180 {
		name = name[:180]
	}
	return name
}

func applyHeaders(req *http.Request, headers map[string]string) {
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
}

func httpDownload(rawURL, dest string, connections int, jobID string, headers map[string]string) (map[string]any, error) {
	client := &http.Client{Timeout: 120 * time.Second}
	req, err := http.NewRequest(http.MethodHead, rawURL, nil)
	if err != nil {
		return nil, err
	}
	applyHeaders(req, headers)
	size := int64(0)
	accept := ""
	if res, err := client.Do(req); err == nil {
		_ = res.Body.Close()
		size = res.ContentLength
		accept = strings.ToLower(res.Header.Get("Accept-Ranges"))
	}
	if size <= 0 || !strings.Contains(accept, "bytes") || connections <= 1 {
		return httpSingle(rawURL, dest, jobID, headers)
	}

	part := (size + int64(connections) - 1) / int64(connections)
	type partInfo struct {
		i    int
		path string
	}
	var (
		mu       sync.Mutex
		errs     []string
		stop     atomic.Bool
		loaded   = make([]int64, connections)
		tmpParts []partInfo
		wg       sync.WaitGroup
	)

	for i := 0; i < connections; i++ {
		start := int64(i) * part
		if start >= size {
			break
		}
		end := start + part - 1
		if end >= size {
			end = size - 1
		}
		partPath := dest + fmt.Sprintf(".part%d", i)
		tmpParts = append(tmpParts, partInfo{i: i, path: partPath})
		wg.Add(1)
		go func(i int, start, end int64, partPath string) {
			defer wg.Done()
			if stop.Load() {
				return
			}
			req, err := http.NewRequest(http.MethodGet, rawURL, nil)
			if err != nil {
				mu.Lock()
				errs = append(errs, err.Error())
				mu.Unlock()
				stop.Store(true)
				return
			}
			applyHeaders(req, headers)
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
			res, err := client.Do(req)
			if err != nil {
				mu.Lock()
				errs = append(errs, err.Error())
				mu.Unlock()
				stop.Store(true)
				return
			}
			defer res.Body.Close()
			f, err := os.Create(partPath)
			if err != nil {
				mu.Lock()
				errs = append(errs, err.Error())
				mu.Unlock()
				stop.Store(true)
				return
			}
			defer f.Close()
			buf := make([]byte, 256*1024)
			for {
				if stop.Load() {
					return
				}
				n, rerr := res.Body.Read(buf)
				if n > 0 {
					if _, werr := f.Write(buf[:n]); werr != nil {
						mu.Lock()
						errs = append(errs, werr.Error())
						mu.Unlock()
						stop.Store(true)
						return
					}
					atomic.AddInt64(&loaded[i], int64(n))
					var sum int64
					for _, v := range loaded {
						sum += atomic.LoadInt64(&v)
					}
					emitProgress(map[string]any{
						"type":   "progress",
						"jobId":  jobID,
						"loaded": sum,
						"total":  size,
						"mode":   "native-helper",
					})
				}
				if rerr == io.EOF {
					break
				}
				if rerr != nil {
					mu.Lock()
					errs = append(errs, rerr.Error())
					mu.Unlock()
					stop.Store(true)
					return
				}
			}
		}(i, start, end, partPath)
	}
	wg.Wait()
	if len(errs) > 0 {
		for _, p := range tmpParts {
			_ = os.Remove(p.path)
		}
		return nil, fmt.Errorf("%s", errs[0])
	}
	out, err := os.Create(dest)
	if err != nil {
		return nil, err
	}
	for _, p := range tmpParts {
		in, err := os.Open(p.path)
		if err != nil {
			out.Close()
			return nil, err
		}
		_, err = io.Copy(out, in)
		in.Close()
		_ = os.Remove(p.path)
		if err != nil {
			out.Close()
			return nil, err
		}
	}
	out.Close()
	st, err := os.Stat(dest)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": dest, "size": st.Size(), "mode": "native-helper"}, nil
}

func httpSingle(rawURL, dest, jobID string, headers map[string]string) (map[string]any, error) {
	client := &http.Client{Timeout: 120 * time.Second}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	applyHeaders(req, headers)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	f, err := os.Create(dest)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	total := res.ContentLength
	var loaded int64
	buf := make([]byte, 256*1024)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return nil, werr
			}
			loaded += int64(n)
			t := total
			if t <= 0 {
				t = loaded
			}
			emitProgress(map[string]any{
				"type":   "progress",
				"jobId":  jobID,
				"loaded": loaded,
				"total":  t,
				"mode":   "native-helper",
			})
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, rerr
		}
	}
	st, err := os.Stat(dest)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": dest, "size": st.Size(), "mode": "native-helper"}, nil
}

func whichFfmpeg() string {
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	for _, p := range []string{"/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func openPath(path string, reveal bool) error {
	if path == "" {
		return fmt.Errorf("path trống")
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	switch runtime.GOOS {
	case "windows":
		if reveal {
			return exec.Command("explorer", "/select,", path).Start()
		}
		return exec.Command("cmd", "/C", "start", "", path).Start()
	case "darwin":
		if reveal {
			return exec.Command("open", "-R", path).Start()
		}
		return exec.Command("open", path).Start()
	default:
		if reveal {
			return exec.Command("xdg-open", filepath.Dir(path)).Start()
		}
		return exec.Command("xdg-open", path).Start()
	}
}

func remuxToMp4(tsPath string) (string, error) {
	ff := whichFfmpeg()
	if ff == "" {
		return "", fmt.Errorf("Chưa cài ffmpeg (brew/winget install ffmpeg) — giữ file .ts")
	}
	out := strings.TrimSuffix(tsPath, filepath.Ext(tsPath)) + ".mp4"
	cmd := exec.Command(ff, "-y", "-i", tsPath, "-c", "copy", "-bsf:a", "aac_adtstoasc", out)
	if outB, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("ffmpeg remux thất bại: %v (%s)", err, string(outB))
	}
	_ = os.Remove(tsPath)
	return out, nil
}

func headerMap(msg map[string]any) map[string]string {
	out := map[string]string{}
	raw, ok := msg["headers"]
	if !ok || raw == nil {
		ref := strField(msg, "referrer")
		if ref == "" {
			ref = strField(msg, "referer")
		}
		if ref != "" {
			out["Referer"] = ref
		}
		return out
	}
	switch t := raw.(type) {
	case map[string]any:
		for k, v := range t {
			if s, ok := v.(string); ok && s != "" {
				out[k] = s
			}
		}
	}
	if _, ok := out["Referer"]; !ok {
		ref := strField(msg, "referrer")
		if ref == "" {
			ref = strField(msg, "referer")
		}
		if ref != "" {
			out["Referer"] = ref
		}
	}
	return out
}

func runYtdlp(rawURL, outDir, jobID string, extra []string, headers map[string]string) (map[string]any, error) {
	ytdlp := whichYtdlp()
	if ytdlp == "" {
		return nil, fmt.Errorf("Chưa cài yt-dlp. Windows: winget install yt-dlp.yt-dlp  |  Mac: brew install yt-dlp")
	}
	if outDir == "" {
		outDir = defaultDownloadDir()
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}
	template := filepath.Join(outDir, "%(title).180B [%(id)s].%(ext)s")
	cmdArgs := []string{"--no-playlist", "--newline", "-o", template, "--no-mtime", "-f", "bv*+ba/b", "--merge-output-format", "mp4"}
	if ref := headers["Referer"]; ref != "" {
		cmdArgs = append(cmdArgs, "--referer", ref)
	}
	if ck := headers["Cookie"]; ck != "" {
		cmdArgs = append(cmdArgs, "--add-header", "Cookie:"+ck)
	}
	if len(extra) > 0 {
		cmdArgs = append(extra, cmdArgs...)
	}
	cmdArgs = append(cmdArgs, rawURL)

	emitProgress(map[string]any{
		"type":    "progress",
		"jobId":   jobID,
		"loaded":  0,
		"total":   0,
		"mode":    "ytdlp",
		"message": "Đang gọi yt-dlp…",
	})

	cmd := exec.Command(ytdlp, cmdArgs...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	activeCmds.Store(jobID, cmd)
	defer activeCmds.Delete(jobID)

	var lastPath string
	pctRE := regexp.MustCompile(`\[download\]\s+([\d.]+)%`)
	alreadyRE := regexp.MustCompile(`has already been downloaded(?::\s*(.+))?$`)
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if m := pctRE.FindStringSubmatch(line); len(m) == 2 {
			pct, _ := strconv.ParseFloat(m[1], 64)
			msg := line
			if len(msg) > 200 {
				msg = msg[:200]
			}
			emitProgress(map[string]any{
				"type":    "progress",
				"jobId":   jobID,
				"percent": pct,
				"mode":    "ytdlp",
				"message": msg,
			})
		}
		if strings.Contains(line, "Destination:") {
			parts := strings.SplitN(line, "Destination:", 2)
			if len(parts) == 2 {
				lastPath = strings.TrimSpace(parts[1])
			}
		}
		if m := alreadyRE.FindStringSubmatch(line); len(m) == 2 && m[1] != "" {
			lastPath = strings.TrimSpace(m[1])
		}
	}
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("yt-dlp thoát lỗi. Kiểm tra URL / cập nhật: yt-dlp -U (%v)", err)
	}

	if lastPath == "" {
		entries, _ := os.ReadDir(outDir)
		var newest string
		var newestT time.Time
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			if newest == "" || info.ModTime().After(newestT) {
				newest = filepath.Join(outDir, e.Name())
				newestT = info.ModTime()
			}
		}
		lastPath = newest
	}
	if lastPath == "" {
		return nil, fmt.Errorf("yt-dlp xong nhưng không tìm thấy file output")
	}
	st, err := os.Stat(lastPath)
	if err != nil {
		return nil, fmt.Errorf("yt-dlp xong nhưng không tìm thấy file output")
	}
	return map[string]any{
		"path":     lastPath,
		"size":     st.Size(),
		"mode":     "ytdlp",
		"filename": filepath.Base(lastPath),
	}, nil
}

func stringSliceField(msg map[string]any, key string) []string {
	v, ok := msg[key]
	if !ok || v == nil {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, a := range arr {
		if s, ok := a.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func handle(msg map[string]any) error {
	mtype := strField(msg, "type")
	jobID := strField(msg, "jobId")
	if jobID == "" {
		jobID = fmt.Sprintf("job_%d", time.Now().Unix())
	}
	hdrs := headerMap(msg)

	switch mtype {
	case "ping", "status":
		return sendMessage(statusPayload())
	case "cancel":
		if v, ok := activeCmds.Load(jobID); ok {
			if cmd, ok := v.(*exec.Cmd); ok && cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			activeCmds.Delete(jobID)
		}
		return sendMessage(map[string]any{"type": "cancelled", "jobId": jobID, "ok": true})
	case "open-path", "reveal-path":
		path := strField(msg, "path")
		reveal := mtype == "reveal-path" || msg["reveal"] == true
		if err := openPath(path, reveal); err != nil {
			return err
		}
		return sendMessage(map[string]any{"type": "done", "ok": true, "path": path})
	case "remux":
		path := strField(msg, "path")
		out, err := remuxToMp4(path)
		if err != nil {
			return err
		}
		st, _ := os.Stat(out)
		size := int64(0)
		if st != nil {
			size = st.Size()
		}
		return sendMessage(map[string]any{
			"type":     "done",
			"ok":       true,
			"path":     out,
			"size":     size,
			"filename": filepath.Base(out),
			"mode":     "remux",
		})
	case "download":
		rawURL := strField(msg, "url")
		if !strings.HasPrefix(rawURL, "http") {
			return fmt.Errorf("URL không hợp lệ")
		}
		outDir := strField(msg, "outDir")
		if outDir == "" {
			outDir = defaultDownloadDir()
		}
		if err := os.MkdirAll(outDir, 0o755); err != nil {
			return err
		}
		filename := safeName(strField(msg, "filename"))
		if filename == "" {
			filename = safeName(fmt.Sprintf("file-%d", time.Now().Unix()))
		}
		dest := filepath.Join(outDir, filename)
		connections := intField(msg, "connections", 8)
		if connections < 1 {
			connections = 1
		}
		if connections > 16 {
			connections = 16
		}
		prefer := strField(msg, "engine")
		if prefer == "" {
			prefer = "auto"
		}
		var result map[string]any
		var err error
		useYtdlp := prefer == "ytdlp" || prefer == "hls" || (prefer == "auto" && looksLikeSitePage(rawURL))
		if useYtdlp {
			result, err = runYtdlp(rawURL, outDir, jobID, stringSliceField(msg, "ytdlpArgs"), hdrs)
		} else {
			result, err = httpDownload(rawURL, dest, connections, jobID, hdrs)
			if err == nil {
				result["filename"] = filename
			}
		}
		if err != nil {
			return err
		}
		out := map[string]any{"type": "done", "jobId": jobID, "ok": true}
		for k, v := range result {
			out[k] = v
		}
		return sendMessage(out)
	case "ytdlp":
		result, err := runYtdlp(strField(msg, "url"), strField(msg, "outDir"), jobID, stringSliceField(msg, "ytdlpArgs"), hdrs)
		if err != nil {
			return err
		}
		out := map[string]any{"type": "done", "jobId": jobID, "ok": true}
		for k, v := range result {
			out[k] = v
		}
		return sendMessage(out)
	default:
		return fmt.Errorf("Unknown type: %s", mtype)
	}
}

func printCLIHelp() {
	fmt.Fprintln(os.Stderr, `PulseDM native host CLI

  pulsedm_host status
  pulsedm_host download [-o DIR] [-e auto|ytdlp|http] [-f NAME] <url>

Examples:
  pulsedm_host download https://example.com/file.zip
  pulsedm_host download -e ytdlp -o ~/Downloads/PulseDM "https://youtu.be/…"
`)
}

func runCLIDownload(args []string) int {
	cliMode = true
	outDir := ""
	engine := "auto"
	filename := ""
	rawURL := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "-h", "--help":
			printCLIHelp()
			return 0
		case "-o", "--out", "--outdir":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "missing value for -o")
				return 2
			}
			outDir = args[i]
		case "-e", "--engine":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "missing value for -e")
				return 2
			}
			engine = args[i]
		case "-f", "--filename":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "missing value for -f")
				return 2
			}
			filename = args[i]
		default:
			if strings.HasPrefix(a, "-") {
				fmt.Fprintf(os.Stderr, "unknown flag: %s\n", a)
				return 2
			}
			if rawURL == "" {
				rawURL = a
			}
		}
	}
	if rawURL == "" || !strings.HasPrefix(rawURL, "http") {
		fmt.Fprintln(os.Stderr, "usage: pulsedm_host download [-o dir] [-e auto|ytdlp|http] <url>")
		return 2
	}
	if outDir == "" {
		outDir = defaultDownloadDir()
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	jobID := fmt.Sprintf("cli_%d", time.Now().Unix())
	prefer := engine
	if prefer == "" {
		prefer = "auto"
	}
	var result map[string]any
	var err error
	useYtdlp := prefer == "ytdlp" || prefer == "hls" || (prefer == "auto" && looksLikeSitePage(rawURL))
	if useYtdlp {
		fmt.Fprintln(os.Stderr, "engine: ytdlp")
		result, err = runYtdlp(rawURL, outDir, jobID, nil, map[string]string{})
	} else {
		if filename == "" {
			filename = safeName(fmt.Sprintf("file-%d", time.Now().Unix()))
			if u, perr := url.Parse(rawURL); perr == nil {
				base := filepath.Base(u.Path)
				if base != "" && base != "/" && base != "." {
					filename = safeName(base)
				}
			}
		} else {
			filename = safeName(filename)
		}
		dest := filepath.Join(outDir, filename)
		fmt.Fprintf(os.Stderr, "engine: http → %s\n", dest)
		result, err = httpDownload(rawURL, dest, 8, jobID, map[string]string{})
		if err == nil {
			result["filename"] = filename
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, err.Error())
		out := map[string]any{"ok": false, "error": err.Error()}
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return 1
	}
	fmt.Fprintln(os.Stderr)
	out := map[string]any{"ok": true, "jobId": jobID}
	for k, v := range result {
		out[k] = v
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
	return 0
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--status", "status":
			b, _ := json.MarshalIndent(statusPayload(), "", "  ")
			fmt.Println(string(b))
			return
		case "download", "fetch":
			os.Exit(runCLIDownload(os.Args[2:]))
		case "-h", "--help", "help":
			printCLIHelp()
			return
		}
	}
	for {
		msg, err := readMessage()
		if err != nil {
			break
		}
		if err := handle(msg); err != nil {
			logf(err.Error())
			_ = sendMessage(map[string]any{
				"type":  "error",
				"jobId": msg["jobId"],
				"ok":    false,
				"error": err.Error(),
			})
		}
	}
}
