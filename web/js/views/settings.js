/* 设置：关于你。 */
import { api } from '../api.js';
import { $, esc, toast } from '../store.js';

export async function load() { /* 无额外数据 */ }

export async function render(el) {
  let p = {};
  try { p = (await api.profile()).persona; } catch (e) { /* 静默 */ }

  el.innerHTML =
    '<div class="page"><div class="page-inner">' +
      '<h2>关于你</h2>' +
      '<p class="sub">知更会用这些称呼你、理解你。只存在你自己的服务里。</p>' +
      '<div class="card">' +
        '<div class="field"><label>怎么称呼你</label>' +
          '<input id="p-name" maxlength="30" value="' + esc(p.name || '') + '" placeholder="比如：小明"></div>' +
        '<div class="field"><label>你的自我介绍（可选）</label>' +
          '<textarea id="p-about" rows="3" maxlength="500" ' +
          'placeholder="比如：学生，最近在做自己的项目">' + esc(p.about || '') + '</textarea></div>' +
        '<div class="form-actions">' +
          '<button class="btn-gold" id="p-save">保存</button>' +
          '<span class="form-hint" id="p-hint"></span>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2 style="font-size:var(--fs-m);margin:0 0 6px">知更是谁</h2>' +
        '<p class="sub" style="margin:0">它会先开口、记得你在意的事、对时间有体感。' +
        '这些能力都在你自己的服务端运行，对话记录只存在你的设备上的数据库里。</p>' +
      '</div>' +
    '</div></div>';

  $('#p-save').addEventListener('click', async () => {
    const hint = $('#p-hint');
    hint.textContent = '保存中…';
    hint.className = 'form-hint';
    try {
      await api.saveProfile({
        name: $('#p-name').value.trim(),
        about: $('#p-about').value.trim(),
      });
      hint.textContent = '已保存 ✓';
      hint.className = 'form-hint ok';
    } catch (e) {
      hint.textContent = e.message || '保存失败';
      hint.className = 'form-hint err';
    }
  });
}
