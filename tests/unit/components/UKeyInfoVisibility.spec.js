import Vue from 'vue'
import { mount } from '@vue/test-utils'
import Panel from '@/components/Apps/UKeyPanel/index.vue'

jest.mock('@/layout/components/Page/TwoColPage.vue', () => ({ render: h => h('div') }))
jest.mock('@/components/Common/IBox', () => ({ render: h => h('div') }))

const serial = 'bound-device'
const binding = { user_id: 'user-id', bound: true, hardware_serial: serial, binding_version: 'v1' }
const cases = [
  ['ji_da', 'vctk_s', "{{ mode === 'admin' || (mode === 'user' && ukey.binding.bound && ukey.devSN === ukey.binding.hardware_serial) }}"],
  ['ji_da', 'builtin', "{{ mode === 'admin' || (mode === 'user' && ukey.devSN === user.ukey_sn) }}"],
  ['long_mai', 'builtin', "{{ mode === 'admin' || (mode === 'user' && ukey.devSN.0 === user.ukey_sn) }}"],
  ['long_mai', 'xjca', "{{ mode === 'admin' }}"]
]

function config(vendor, provider, when, bound = true) {
  const remote = provider !== 'builtin'
  return {
    config: {
      vendor, provider, revision: 'r1', certType: 1, poll_interval: 5000,
      capabilities: { binding_mode: remote ? 'certificate' : 'user_sn' },
      own_binding: { ...binding, bound }, api: { certificate_binding_url: '/binding/{user_id}/' }
    },
    sdk: {
      create: { constructor: 'VisibilityUKey' },
      setup: { steps: [{ call: 'readDevice', register: 'ukey.devSN' }] }
    },
    info: {
      when,
      device: [{ key: 'serial', value: vendor === 'ji_da' ? '{{ ukey.devSN }}' : '{{ ukey.devSN.0 }}' }],
      cert: [{ key: 'cn', label: 'CN', call: 'UKey_GetCertInfo', args: [1, 9] }]
    },
    operations: { when, items: [{ key: 'bindUserUKeySN', scope: 'admin' }] }
  }
}

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await Vue.nextTick()
}

describe('reactive device and certificate information visibility', () => {
  let wrapper, script, sdk, device, get

  beforeEach(() => {
    jest.useFakeTimers()
    device = serial
  })

  afterEach(() => {
    if (wrapper) wrapper.destroy()
    wrapper = null
    if (script) script.remove()
    script = null
    delete window.VisibilityUKey
    jest.useRealTimers()
  })

  async function open(vendor, provider, when, { mode = 'user', bound = true } = {}) {
    const loaded = config(vendor, provider, when, bound)
    const readDevice = () => vendor === 'ji_da' ? device : device ? [device] : []
    sdk = {
      readDevice: jest.fn(readDevice),
      UKey_GetDevSN: jest.fn(readDevice),
      UKey_GetCertInfo: jest.fn((type, field) => field === 14
        ? JSON.stringify({ SubjectCN: 'certificate-owner' }) : 'certificate-owner')
    }
    window.VisibilityUKey = jest.fn(function() { Object.assign(this, sdk) })
    script = document.createElement('script')
    script.id = 'ukey-sdk-script'
    script.dataset.vendor = vendor
    script.dataset.provider = provider
    document.body.appendChild(script)
    get = jest.fn(url => Promise.resolve(url.startsWith('/binding/') ? { ...binding, bound } : loaded))
    wrapper = mount(Panel, {
      propsData: { mode, object: { id: 'user-id', ukey_sn: serial } },
      mocks: { $t: key => key, $axios: { get }, $store: { getters: { publicSettings: {} } } },
      stubs: ['el-dialog', 'el-form', 'el-alert', 'el-button', 'el-empty']
    })
    await flush()
    return wrapper.vm
  }

  it.each(cases)('shows matching device and certificate information for %s / %s without changing access rules', async (vendor, provider, when) => {
    const vm = await open(vendor, provider, when)
    const visible = provider !== 'xjca'
    expect(vm.infoWhenPassed).toBe(visible)
    expect(vm.hasCert).toBe(visible)
    expect(vm.deviceInfoItems).toHaveLength(visible ? 1 : 0)
    expect(sdk.UKey_GetCertInfo).toHaveBeenCalledTimes(visible ? 1 : 0)
    expect(vm.visibleOperations).toEqual([])
    if (visible) expect(vm.certInfoItems[0].value).toBe('certificate-owner')
    if (provider === 'vctk_s') {
      expect(sdk.UKey_GetCertInfo.mock.calls).toEqual([[1, 14]])
      expect(vm.pollTimer).toBe(null)
      jest.advanceTimersByTime(15000)
      await flush()
      expect(sdk.UKey_GetCertInfo).toHaveBeenCalledTimes(1)
    }
  })

  it.each(cases)('does not read certificates from a mismatched ordinary-user device for %s / %s', async (vendor, provider, when) => {
    device = 'another-device'
    const vm = await open(vendor, provider, when)
    expect(vm.infoWhenPassed).toBe(false)
    expect(vm.hasCert).toBe(false)
    expect(vm.deviceInfoItems).toEqual([])
    expect(sdk.UKey_GetCertInfo).not.toHaveBeenCalled()
  })

  it.each(cases.filter(([, provider]) => provider === 'builtin'))('updates information after existing device polls for %s / %s', async (vendor, provider, when) => {
    const vm = await open(vendor, provider, when)
    device = ''
    await vm.pollStatus()
    await flush()
    expect(vm.infoWhenPassed).toBe(false)
    expect(vm.deviceInfoItems).toEqual([])
    expect(vm.hasCert).toBe(false)
    expect(sdk.UKey_GetCertInfo).toHaveBeenCalledTimes(1)
    device = serial
    await vm.pollStatus()
    await flush()
    expect(vm.infoWhenPassed).toBe(true)
    expect(vm.hasCert).toBe(true)
    expect(sdk.UKey_GetCertInfo).toHaveBeenCalledTimes(2)
  })

  it('does not start certificate reading for an unbound VCTK_S ordinary user', async () => {
    const vm = await open(...cases[0], { bound: false })
    expect(vm.infoWhenPassed).toBe(false)
    expect(sdk.UKey_GetCertInfo).not.toHaveBeenCalled()
    expect(window.VisibilityUKey).not.toHaveBeenCalled()
  })

  it('keeps one VCTK_S certificate read per entry and stops reads while inactive', async () => {
    const vm = await open(...cases[0])
    vm.leavePage()
    jest.advanceTimersByTime(15000)
    await flush()
    expect(sdk.UKey_GetCertInfo).toHaveBeenCalledTimes(1)
    await vm.enterPage()
    await flush()
    expect(vm.hasCert).toBe(true)
    expect(sdk.UKey_GetCertInfo).toHaveBeenCalledTimes(2)
    expect(vm.pollTimer).toBe(null)
  })

  it('does not retry cancelled VCTK_S certificate selection on a timer', async () => {
    const vm = await open(...cases[0])
    vm.leavePage()
    sdk.UKey_GetCertInfo.mockImplementation(() => { throw new Error('cancelled') })
    await vm.enterPage()
    await flush()
    jest.advanceTimersByTime(15000)
    await flush()
    expect(vm.hasCert).toBe(false)
    expect(sdk.UKey_GetCertInfo).toHaveBeenCalledTimes(2)
    expect(vm.pollTimer).toBe(null)
  })

  it.each(cases)('keeps administrator information visible for %s / %s', async (vendor, provider, when) => {
    const vm = await open(vendor, provider, when, { mode: 'admin' })
    expect(vm.infoWhenPassed).toBe(true)
    expect(vm.hasCert).toBe(true)
  })
})
