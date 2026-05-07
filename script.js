let isFetching = false;
let currentCourse = null;
let allFilteredData = [];
let modelPredictions = [];
let modelPredictionSource = "live-attendance-fallback";
let isAdmin = false;

const MODEL_PREDICTIONS_PATH = "../ai_model/artifacts/risk_predictions.json";
const TEACHER_DATA_URL = "teacher-data.html";
const ATTENDANCE_API_URL = "https://script.google.com/macros/s/AKfycbwgHq6afWZdxx_TP3OPEOHspCt0udn1jayl_XZn-T4oVmvg8YxeOkrWJkIesqVxZxzV/exec";
const LOCAL_ATTENDANCE_PATHS = {
    IOT: "data/IOT.json",
    Java: "data/Java.json"
};

const courses = [
    { label: "All Subjects", value: "ALL" },
    { label: "IOT", value: "IOT" },
    { label: "Oops With Java", value: "Java" }
];

// Admin credentials
const ADMIN_CREDENTIALS = {
    username: "IOTPROF",
    password: "2026"
};

function showLoginModal() {
    const modal = document.createElement("div");
    modal.className = "login-modal";
    modal.innerHTML = `
        <div class="login-container">
            <h2>Professor Login</h2>
            <input type="text" id="username" placeholder="Username" />
            <input type="password" id="password" placeholder="Password" />
            <button onclick="handleLogin()">Login</button>
            <button onclick="closeLoginModal()">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);

    const usernameInput = document.getElementById("username");
    const passwordInput = document.getElementById("password");

    const handleEnterKey = (event) => {
        if (event.key === "Enter") {
            handleLogin();
        }
    };

    usernameInput.addEventListener("keypress", handleEnterKey);
    passwordInput.addEventListener("keypress", handleEnterKey);
}

function closeLoginModal() {
    const modal = document.querySelector(".login-modal");
    if (modal) {
        modal.remove();
    }
}

function handleLogin() {
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        isAdmin = true;
        closeLoginModal();
        window.open(TEACHER_DATA_URL, "_blank");
    } else {
        alert("Invalid credentials");
    }
}

function showDashboard() {
    document.getElementById("landingPage").style.display = "none";
    document.getElementById("dashboardPage").style.display = "block";
    window.scrollTo(0, 0);

    if (!currentCourse) {
        initializeCourseTabs();
    }

    searchByBatch();
}

function showLandingPage() {
    document.getElementById("landingPage").style.display = "block";
    document.getElementById("dashboardPage").style.display = "none";
    window.scrollTo(0, 0);
}

function initializeCourseTabs() {
    const courseTabs = document.getElementById("courseTabs");
    courseTabs.innerHTML = "";

    courses.forEach(course => {
        const tab = document.createElement("div");
        tab.className = "course-tab";
        tab.textContent = course.label;
        tab.onclick = () => {
            document.querySelectorAll(".course-tab").forEach(item => item.classList.remove("active"));
            tab.classList.add("active");
            currentCourse = course.value;
            searchByBatch();
        };
        courseTabs.appendChild(tab);
    });

    courseTabs.firstChild?.classList.add("active");
    currentCourse = courses[0].value;
}

async function searchByBatch() {
    const tablesContainer = document.getElementById("tablesContainer");
    tablesContainer.innerHTML = "";
    document.getElementById("enrollSearchContainer").style.display = "none";
    allFilteredData = [];
    renderAIRiskLoading();

    const batch = document.getElementById("batchSelector").value;

    const loadingDiv = document.createElement("div");
    loadingDiv.className = "loading-state";
    loadingDiv.textContent = "Fetching attendance data...";
    tablesContainer.appendChild(loadingDiv);

    if (currentCourse === "ALL") {
        for (let course of courses.slice(1)) {
            await fetchAttendance(course.value, batch);
        }
    } else {
        await fetchAttendance(currentCourse, batch);
    }

    loadingDiv.remove();
    if (allFilteredData.length > 0) {
        document.getElementById("enrollSearchContainer").style.display = "block";
    }

    await loadModelPredictions();
    renderAIRiskAnalysis();
}

function getBatchRange(batch) {
    if (batch === "B1") {
        const baseRange = Array.from({ length: 65 }, (_, index) => index + 1);
        const extras = [604, 607, 610, 611, 612];
        return [...baseRange, ...extras];
    }
    if (batch === "B2") {
        const baseRange = Array.from({ length: 137 }, (_, index) => index + 66);
        const extras = [601, 602, 603, 605, 606, 608, 609];
        return [...baseRange, ...extras];
    }
    return Array.from({ length: 999 }, (_, index) => index + 1);
}

async function fetchAttendance(course, batch) {
    if (isFetching) return;

    isFetching = true;
    const tablesContainer = document.getElementById("tablesContainer");
    const rollList = getBatchRange(batch);

    try {
        const { headers, data, error, source } = await loadAttendanceData(course);

        if (error) throw new Error(error);

        const filteredData = data.filter(row => {
            const enroll = parseInt(row[1]);
            return !isNaN(enroll) && rollList.includes(enroll);
        });

        allFilteredData.push({ course, headers, data: filteredData, source });
        if (filteredData.length > 0) {
            createFilteredTable(course, headers, filteredData, tablesContainer);
        }
    } catch (error) {
        console.error(`Error fetching data for ${course}:`, error);
        const errorDiv = document.createElement("div");
        errorDiv.className = "empty-risk-state";
        errorDiv.textContent = `No attendance data available for ${course}.`;
        tablesContainer.appendChild(errorDiv);
    } finally {
        isFetching = false;
    }
}

async function loadAttendanceData(course) {
    try {
        const response = await fetch(`${ATTENDANCE_API_URL}?sheet=${course}`);
        if (!response.ok) {
            throw new Error("Google Apps Script unavailable");
        }
        const payload = await response.json();
        return { ...payload, headers: normalizeAttendanceHeaders(payload.headers), source: "Google Sheets" };
    } catch (remoteError) {
        console.info(`Using local demo data for ${course}.`, remoteError);
        const localPath = LOCAL_ATTENDANCE_PATHS[course];
        if (!localPath) {
            throw remoteError;
        }
        const response = await fetch(`${localPath}?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`Local demo data missing for ${course}`);
        }
        const payload = await response.json();
        return { ...payload, headers: normalizeAttendanceHeaders(payload.headers), source: "Local Demo Data" };
    }
}

function normalizeAttendanceHeaders(headers = []) {
    return headers.map(header => {
        const value = String(header || "");
        const slashDate = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
        if (slashDate) {
            const day = slashDate[1].padStart(2, "0");
            const month = slashDate[2].padStart(2, "0");
            return `${day}/${month}/26`;
        }

        const dashDate = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (dashDate) {
            return `${dashDate[3].padStart(2, "0")}/${dashDate[2].padStart(2, "0")}/26`;
        }

        return value;
    });
}

function filterByEnrollment() {
    const input = document.getElementById("searchBox").value.trim().toLowerCase();
    const tablesContainer = document.getElementById("tablesContainer");
    tablesContainer.innerHTML = "";

    let targets = [];

    if (input.includes(",")) {
        targets = input.split(",").map(value => parseInt(value.trim())).filter(value => !isNaN(value));
    } else if (input.includes("-")) {
        const parts = input.split("-").map(part => parseInt(part.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            for (let i = parts[0]; i <= parts[1]; i++) targets.push(i);
        }
    } else {
        const value = parseInt(input);
        if (!isNaN(value)) {
            targets.push(value);
        }
    }

    if (targets.length === 0) {
        allFilteredData.forEach(({ course, headers, data }) => {
            createFilteredTable(course, headers, data, tablesContainer);
        });
        return;
    }

    allFilteredData.forEach(({ course, headers, data }) => {
        const filtered = data.filter(row => {
            const enroll = parseInt(row[1]);
            return targets.includes(enroll);
        });

        if (filtered.length > 0) {
            createFilteredTable(course, headers, filtered, tablesContainer);
        }
    });
}

async function refreshAIRiskAnalysis() {
    await loadModelPredictions(true);
    renderAIRiskAnalysis();
}

async function loadModelPredictions(forceReload = false) {
    if (modelPredictions.length > 0 && !forceReload) {
        return;
    }

    try {
        const response = await fetch(`${MODEL_PREDICTIONS_PATH}?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) {
            throw new Error("Prediction file not available yet");
        }
        const predictions = await response.json();
        if (!Array.isArray(predictions)) {
            throw new Error("Prediction file must be a JSON array");
        }
        modelPredictions = predictions;
        modelPredictionSource = "pytorch-model-output";
    } catch (error) {
        modelPredictions = [];
        modelPredictionSource = "live-attendance-fallback";
        console.info("Using browser-side risk analysis until PyTorch predictions are exported.", error);
    }
}

function renderAIRiskLoading() {
    const status = document.getElementById("aiRiskModelStatus");
    const summary = document.getElementById("aiRiskSummary");
    const list = document.getElementById("riskListContainer");
    if (!status || !summary || !list) return;

    status.textContent = "Analysing attendance data...";
    summary.innerHTML = "";
    list.innerHTML = "";
}

function renderAIRiskAnalysis() {
    const status = document.getElementById("aiRiskModelStatus");
    const summary = document.getElementById("aiRiskSummary");
    const list = document.getElementById("riskListContainer");
    if (!status || !summary || !list) return;

    const rows = modelPredictions.length > 0
        ? getModelPredictionRows()
        : buildRiskRowsFromAttendance();

    const selectedRiskFilter = document.getElementById("riskFilter")?.value || "ALL";
    const visibleRows = selectedRiskFilter === "ALL"
        ? rows
        : rows.filter(row => row.riskStatus === selectedRiskFilter);
    const atRiskRows = rows.filter(row => row.riskStatus === "At Risk");
    const monitorRows = rows.filter(row => row.riskStatus === "Monitor");
    const stableRows = rows.filter(row => row.riskStatus === "Not At Risk");
    const averageRisk = rows.length
        ? Math.round(rows.reduce((sum, row) => sum + row.riskProbability, 0) / rows.length * 100)
        : 0;

    status.textContent = modelPredictionSource === "pytorch-model-output"
        ? "Using PyTorch model predictions from risk_predictions.json"
        : "Live heuristic analysis active until the PyTorch prediction file is generated";

    summary.innerHTML = "";
    [
        { label: "Students Analysed", value: rows.length },
        { label: "At Risk", value: atRiskRows.length },
        { label: "Monitor", value: monitorRows.length },
        { label: "Not At Risk", value: stableRows.length },
        { label: "Average Risk", value: `${averageRisk}%` }
    ].forEach(item => {
        const card = document.createElement("div");
        card.className = "ai-summary-card";
        const value = document.createElement("strong");
        value.textContent = item.value;
        const label = document.createElement("span");
        label.textContent = item.label;
        card.append(value, label);
        summary.appendChild(card);
    });

    list.innerHTML = "";
    if (visibleRows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-risk-state";
        empty.textContent = rows.length === 0
            ? "No attendance rows available for AI analysis."
            : "No students match the selected AI risk filter.";
        list.appendChild(empty);
        return;
    }

    const table = document.createElement("table");
    table.className = "risk-table";
    const thead = document.createElement("thead");
    thead.innerHTML = `
        <tr>
            <th>Enrollment</th>
            <th>Student</th>
            <th>Status</th>
            <th>Confidence</th>
            <th>Risk Reason</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    visibleRows
        .sort((a, b) => b.riskProbability - a.riskProbability)
        .forEach(row => {
            const tr = document.createElement("tr");
            const statusClass = getRiskBadgeClass(row.riskStatus);
            const confidencePercent = Math.round(row.confidence * 100);
            tr.innerHTML = `
                <td>${row.enrollment}</td>
                <td>${row.name || "-"}</td>
                <td><span class="${statusClass}">${row.riskStatus}</span></td>
                <td>
                    <div class="confidence-cell">
                        <span>${confidencePercent}%</span>
                        <div class="confidence-track">
                            <div class="confidence-fill" style="width: ${confidencePercent}%"></div>
                        </div>
                    </div>
                </td>
                <td>${row.reason}</td>
            `;
            tbody.appendChild(tr);
        });
    table.appendChild(tbody);
    list.appendChild(table);
}

function getModelPredictionRows() {
    const batch = document.getElementById("batchSelector").value;
    const allowedRolls = new Set(getBatchRange(batch));
    return modelPredictions
        .map(prediction => ({
            enrollment: parseInt(prediction.enrollment ?? prediction.Enrollment),
            name: prediction.name ?? prediction.Name ?? "",
            riskStatus: normalizeRiskStatus(prediction.riskStatus ?? prediction.RiskStatus, Number(prediction.riskProbability ?? prediction.confidence ?? 0.5)),
            confidence: Number(prediction.confidence ?? 0.5),
            riskProbability: Number(prediction.riskProbability ?? prediction.confidence ?? 0.5),
            reason: prediction.reason ?? "model confidence"
        }))
        .filter(row => !isNaN(row.enrollment) && allowedRolls.has(row.enrollment));
}

function buildRiskRowsFromAttendance() {
    const studentMap = new Map();

    allFilteredData.forEach(({ headers, data }) => {
        const special = getSpecialColumnIndexes(headers);
        const attendanceIndexes = headers
            .map((_, index) => index)
            .filter(index => index > 1 && !Object.values(special).includes(index));

        data.forEach(row => {
            const enrollment = parseInt(row[1]);
            if (isNaN(enrollment)) return;

            const values = attendanceIndexes
                .map(index => String(row[index] || "").trim().toUpperCase())
                .filter(value => value === "P" || value === "A");

            const existing = studentMap.get(enrollment) || {
                enrollment,
                name: row[0] || "",
                totalSessions: 0,
                totalAbsences: 0,
                recentAbsenceRates: [],
                absenceStreaks: [],
                requiredValues: [],
                canSkipValues: [],
                midSemValues: [],
                internalValues: []
            };

            existing.totalSessions += values.length;
            existing.totalAbsences += values.filter(value => value === "A").length;
            existing.recentAbsenceRates.push(getRecentAbsenceRate(values));
            existing.absenceStreaks.push(getLongestAbsenceStreak(values));
            pushNumeric(existing.requiredValues, row[special.required]);
            pushNumeric(existing.canSkipValues, row[special.canSkip]);
            pushNumeric(existing.midSemValues, row[special.midSem]);
            pushNumeric(existing.internalValues, row[special.internal]);

            studentMap.set(enrollment, existing);
        });
    });

    return Array.from(studentMap.values()).map(student => {
        const attendanceRate = student.totalSessions
            ? 1 - (student.totalAbsences / student.totalSessions)
            : 0;
        const recentAbsenceRate = average(student.recentAbsenceRates);
        const absenceStreak = Math.max(0, ...student.absenceStreaks);
        const avgMidSem = average(student.midSemValues);
        const avgInternal = average(student.internalValues);
        const avgRequired = average(student.requiredValues);
        const avgCanSkip = average(student.canSkipValues);

        let riskProbability = 0.12;
        const reasons = [];

        if (attendanceRate < 0.75) {
            riskProbability += 0.35;
            reasons.push("low attendance");
        }
        if (recentAbsenceRate >= 0.4) {
            riskProbability += 0.2;
            reasons.push("recent absence trend");
        }
        if (absenceStreak >= 3) {
            riskProbability += 0.2;
            reasons.push("consecutive absences");
        }
        if (avgMidSem > 0 && avgMidSem < 25) {
            riskProbability += 0.15;
            reasons.push("low mid-sem score");
        }
        if (avgInternal > 0 && avgInternal < 12) {
            riskProbability += 0.1;
            reasons.push("low internal score");
        }
        if (avgRequired > avgCanSkip && avgRequired >= 4) {
            riskProbability += 0.08;
            reasons.push("attendance shortage");
        }

        riskProbability = Math.min(0.96, riskProbability);
        const riskStatus = getRiskStatusFromProbability(riskProbability);

        return {
            enrollment: student.enrollment,
            name: student.name,
            riskStatus,
            confidence: riskStatus === "Not At Risk" ? 1 - riskProbability : riskProbability,
            riskProbability,
            reason: reasons.length ? reasons.join(", ") : "attendance and marks currently stable"
        };
    });
}

function normalizeRiskStatus(value, probability) {
    if (value === "At Risk" || value === "Monitor" || value === "Not At Risk") {
        return value;
    }
    return getRiskStatusFromProbability(probability);
}

function getRiskStatusFromProbability(probability) {
    if (probability >= 0.65) return "At Risk";
    if (probability >= 0.42) return "Monitor";
    return "Not At Risk";
}

function getRiskBadgeClass(status) {
    if (status === "At Risk") return "risk-badge risk-high";
    if (status === "Monitor") return "risk-badge risk-medium";
    return "risk-badge risk-low";
}

function getSpecialColumnIndexes(headers) {
    const indexes = {
        required: -1,
        canSkip: -1,
        midSem: -1,
        internal: -1
    };

    headers.forEach((header, index) => {
        const value = String(header || "").toUpperCase();
        if (value.includes("REQUIRED")) indexes.required = index;
        if (value.includes("SKIP")) indexes.canSkip = index;
        if (value.includes("MID") || value.includes("SEM")) indexes.midSem = index;
        if (value.includes("INTERNAL")) indexes.internal = index;
    });

    if (indexes.required === -1) indexes.required = headers.length - 4;
    if (indexes.canSkip === -1) indexes.canSkip = headers.length - 3;
    if (indexes.midSem === -1) indexes.midSem = headers.length - 2;
    if (indexes.internal === -1) indexes.internal = headers.length - 1;

    return indexes;
}

function getRecentAbsenceRate(values) {
    const recentValues = values.slice(-5);
    if (recentValues.length === 0) return 0;
    return recentValues.filter(value => value === "A").length / recentValues.length;
}

function getLongestAbsenceStreak(values) {
    let longest = 0;
    let current = 0;
    values.forEach(value => {
        if (value === "A") {
            current++;
            longest = Math.max(longest, current);
        } else {
            current = 0;
        }
    });
    return longest;
}

function pushNumeric(list, value) {
    const number = parseFloat(value);
    if (!isNaN(number)) {
        list.push(number);
    }
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createFilteredTable(title, headers, data, container) {
    const nonEmptyColumns = headers.map((_, colIndex) =>
        data.some(row => row[colIndex] && row[colIndex] !== "-")
    );

    const filteredHeaders = headers.filter((_, colIndex) => nonEmptyColumns[colIndex]);

    const subjectLabel = document.createElement("div");
    subjectLabel.className = "subject-label";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const faculty = document.createElement("small");
    faculty.textContent = ` (${getProfessorName(title)})`;
    subjectLabel.append(strong, faculty);
    container.appendChild(subjectLabel);

    let validRow = null;
    const special = getSpecialColumnIndexes(headers);

    for (let row of data) {
        const req = parseInt(row[special.required]);
        const skip = parseInt(row[special.canSkip]);
        if (!isNaN(req) && req !== -1 && !isNaN(skip)) {
            validRow = row;
            break;
        }
    }

    let totalHeld = 0;
    let required = 0;
    let canSkip = 0;
    let totalLectures = 0;

    if (validRow) {
        required = parseInt(validRow[special.required]) || 0;
        canSkip = parseInt(validRow[special.canSkip]) || 0;

        for (let i = 2; i < special.required; i++) {
            if (i === special.midSem || i === special.internal) continue;

            const value = (validRow[i] || "").toString().trim().toUpperCase();
            if (value === "P" || value === "A") totalHeld++;
        }

        totalLectures = totalHeld + required + canSkip;
    }

    const lectureInfo = document.createElement("div");
    lectureInfo.className = "lecture-info";
    lectureInfo.textContent = `Lectures Held: ${totalHeld} | Total Lectures: ${totalLectures}`;
    container.appendChild(lectureInfo);

    const table = document.createElement("table");
    table.className = "subject-table";
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");

    const headerRow = document.createElement("tr");
    filteredHeaders.forEach(header => {
        const th = document.createElement("th");
        th.innerText = header;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    data.forEach(row => {
        const tr = document.createElement("tr");
        row.forEach((cell, index) => {
            if (nonEmptyColumns[index]) {
                const td = document.createElement("td");
                td.innerText = cell || "-";
                tr.appendChild(td);
            }
        });
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
}

function getProfessorName(subject) {
    const professors = {
        IOT: "Dr. Khyati Chopra",
        Java: "Dr. Renu Dalal"
    };
    return professors[subject] || "Faculty";
}

document.addEventListener("DOMContentLoaded", () => {
    showLandingPage();

    document.getElementById("searchBox").addEventListener("input", filterByEnrollment);

    document.getElementById("batchSelector").addEventListener("change", function() {
        if (document.getElementById("dashboardPage").style.display === "block") {
            searchByBatch();
        }
    });

    document.getElementById("riskFilter").addEventListener("change", renderAIRiskAnalysis);

    const buttonContainer = document.querySelector(".button-container");
    const adminBtn = document.createElement("button");
    adminBtn.className = "secondary-btn";
    adminBtn.textContent = "Professor Login";
    adminBtn.onclick = showLoginModal;
    buttonContainer.appendChild(adminBtn);
});
